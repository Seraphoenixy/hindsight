package main

import (
	"encoding/json"
	"net/http"
	"os"
	"testing"
)

func TestV3ReplaysInterruptedCommit(t *testing.T) {
	dir := t.TempDir()
	s, err := newRelay(dir, testToken, defaultMaxRelayBytes)
	if err != nil {
		t.Fatal(err)
	}
	st, err := s.newV3StateLocked()
	if err != nil {
		t.Fatal(err)
	}
	st.LastSeq = 1
	if err := s.commitV3Locked(st, nil, []v3ChangeLogEntry{{Seq: 1}}); err != nil {
		t.Fatal(err)
	}
	log, err := os.ReadFile(s.v3ChangesPath())
	if err != nil {
		t.Fatal(err)
	}

	// Simulate a crash after persisting the journal and writing part of a record.
	st.LastSeq = 2
	commit := v3Commit{State: st, LogOffset: int64(len(log)), Changes: []v3ChangeLogEntry{{Seq: 2}}}
	raw, err := json.Marshal(commit)
	if err != nil {
		t.Fatal(err)
	}
	if err := atomicWriteFile(s.v3Dir(), s.v3CommitPath(), raw); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.v3ChangesPath(), append(log, []byte(`{"seq":`)...), 0600); err != nil {
		t.Fatal(err)
	}

	reopened, err := newRelay(dir, testToken, defaultMaxRelayBytes)
	if err != nil {
		t.Fatal(err)
	}
	result := apiJSON(t, reopened.handler(), http.MethodGet, v3ChangesPath, testToken, "", nil)
	var actual struct {
		LastSeq int64              `json:"last_seq"`
		Changes []v3ChangeLogEntry `json:"changes"`
	}
	if err := json.Unmarshal(result.Body.Bytes(), &actual); err != nil {
		t.Fatal(err)
	}
	if actual.LastSeq != 2 || len(actual.Changes) != 2 || actual.Changes[0].Seq != 1 || actual.Changes[1].Seq != 2 {
		t.Fatalf("unexpected recovered sequence: %+v", actual)
	}
}
