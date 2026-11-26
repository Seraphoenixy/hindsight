package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

type v3Commit struct {
	State     *v3State                   `json:"state"`
	Objects   map[string]*v3ObjectRecord `json:"objects"`
	Changes   []v3ChangeLogEntry         `json:"changes"`
	LogOffset int64                      `json:"log_offset"`
}

func (s *relay) v3CommitPath() string {
	return filepath.Join(s.v3Dir(), "pending-commit.json")
}

func (s *relay) commitV3Locked(state *v3State, objects map[string]*v3ObjectRecord, changes []v3ChangeLogEntry) error {
	var offset int64
	info, err := os.Stat(s.v3ChangesPath())
	if err == nil {
		offset = info.Size()
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	journal := v3Commit{State: state, Objects: objects, Changes: changes, LogOffset: offset}
	data, err := json.Marshal(journal)
	if err != nil {
		return err
	}
	// Publish the recovery intent before mutating any component of the revision.
	if err := atomicWriteFile(s.v3Dir(), s.v3CommitPath(), data); err != nil {
		return err
	}
	return s.finishV3CommitLocked(&journal)
}

func (s *relay) recoverV3CommitLocked() error {
	data, err := os.ReadFile(s.v3CommitPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var journal v3Commit
	if err := json.Unmarshal(data, &journal); err != nil {
		return err
	}
	if journal.State == nil || journal.LogOffset < 0 {
		return errors.New("invalid v3 commit journal")
	}
	return s.finishV3CommitLocked(&journal)
}

func (s *relay) finishV3CommitLocked(journal *v3Commit) error {
	if len(journal.Changes) > 0 {
		if err := s.replayV3Log(journal); err != nil {
			return err
		}
	}
	if err := s.saveV3ObjectsLocked(journal.Objects); err != nil {
		return err
	}
	if err := s.saveV3StateLocked(journal.State); err != nil {
		return err
	}
	if err := os.Remove(s.v3CommitPath()); err != nil {
		return err
	}
	return syncDirectory(s.v3Dir())
}

func (s *relay) replayV3Log(journal *v3Commit) error {
	log, err := os.OpenFile(s.v3ChangesPath(), os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	info, err := log.Stat()
	if err != nil {
		return err
	}
	if info.Size() < journal.LogOffset {
		return errors.New("v3 log is shorter than the committed offset")
	}
	// A prior attempt may have written part or all of this batch. Replay it
	// from the pre-commit offset so sequence numbers appear exactly once.
	if err := log.Truncate(journal.LogOffset); err != nil {
		return err
	}
	if _, err := log.Seek(journal.LogOffset, io.SeekStart); err != nil {
		return err
	}
	encoder := json.NewEncoder(log)
	for _, change := range journal.Changes {
		if err := encoder.Encode(change); err != nil {
			return err
		}
	}
	return log.Sync()
}
