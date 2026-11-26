package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

const (
	v3StatusPath       = "/v3/status"
	v3BootstrapPath    = "/v3/bootstrap"
	v3ChangesPath      = "/v3/changes"
	v3BaselinePath     = "/v3/baseline"
	v3BlobsMissingPath = "/v3/blobs/missing"
	v3BlobsPrefix      = "/v3/blobs/"
	maxV3BodyBytes     = 64 * 1024 * 1024
)

type v3State struct {
	Protocol         int               `json:"protocol"`
	Epoch            string            `json:"epoch"`
	RelayVersion     int64             `json:"relay_version"`
	LastSeq          int64             `json:"last_seq"`
	CommittedBatches map[string]string `json:"committed_batches,omitempty"`
}

type v3ObjectRecord struct {
	ObjectType     string         `json:"object_type"`
	BankID         string         `json:"bank_id"`
	ObjectID       string         `json:"object_id"`
	Op             string         `json:"op"`
	RelayVersion   int64          `json:"relay_version"`
	Seq            int64          `json:"seq"`
	ContentHash    string         `json:"content_hash"`
	Deleted        bool           `json:"deleted"`
	Payload        map[string]any `json:"payload,omitempty"`
	OriginDeviceID string         `json:"origin_device_id"`
	UpdatedAt      string         `json:"updated_at"`
}

type v3ChangeLogEntry struct {
	Seq              int64          `json:"seq"`
	ObjectType       string         `json:"object_type"`
	BankID           string         `json:"bank_id"`
	ObjectID         string         `json:"object_id"`
	Op               string         `json:"op"`
	RelayVersion     int64          `json:"relay_version"`
	BaseRelayVersion int64          `json:"base_relay_version"`
	ContentHash      string         `json:"content_hash"`
	Deleted          bool           `json:"deleted"`
	Payload          map[string]any `json:"payload,omitempty"`
	OriginDeviceID   string         `json:"origin_device_id"`
	UpdatedAt        string         `json:"updated_at"`
}

type v3PushItem struct {
	ClientSeq        int64          `json:"client_seq"`
	ObjectType       string         `json:"object_type"`
	BankID           string         `json:"bank_id"`
	ObjectID         string         `json:"object_id"`
	Op               string         `json:"op"`
	LocalVersion     int64          `json:"local_version"`
	BaseRelayVersion int64          `json:"base_relay_version"`
	ContentHash      string         `json:"content_hash"`
	Payload          map[string]any `json:"payload,omitempty"`
}

type v3AcceptedItem struct {
	ClientSeq    int64  `json:"client_seq"`
	ObjectType   string `json:"object_type"`
	BankID       string `json:"bank_id"`
	ObjectID     string `json:"object_id"`
	Seq          int64  `json:"seq"`
	RelayVersion int64  `json:"relay_version"`
	ContentHash  string `json:"content_hash"`
	Deleted      bool   `json:"deleted"`
}

type v3ConflictItem struct {
	ClientSeq        int64          `json:"client_seq"`
	ObjectType       string         `json:"object_type"`
	BankID           string         `json:"bank_id"`
	ObjectID         string         `json:"object_id"`
	LocalVersion     int64          `json:"local_version"`
	BaseRelayVersion int64          `json:"base_relay_version"`
	RelayVersion     int64          `json:"relay_version"`
	RelayOp          string         `json:"relay_op"`
	RelayContentHash string         `json:"relay_content_hash"`
	RelayDeleted     bool           `json:"relay_deleted"`
	RelayPayload     map[string]any `json:"relay_payload,omitempty"`
	RelayDeviceID    string         `json:"relay_device_id"`
	RelaySeq         int64          `json:"relay_seq"`
}

func atomicWriteFile(dir, target string, data []byte) error {
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, target); err != nil {
		return err
	}
	cleanup = false
	return syncDirectory(dir)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		internalError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func (s *relay) v3StatePath() string {
	return filepath.Join(s.v3Dir(), "state.json")
}

func (s *relay) v3ObjectsPath() string {
	return filepath.Join(s.v3Dir(), "objects.json")
}

func (s *relay) v3ChangesPath() string {
	return filepath.Join(s.v3Dir(), "changes.jsonl")
}

func (s *relay) v3BlobsDir() string {
	return filepath.Join(s.v3Dir(), "blobs")
}

func (s *relay) loadV3StateLocked() (*v3State, error) {
	if err := s.recoverV3CommitLocked(); err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(s.v3StatePath())
	if err != nil {
		return nil, err
	}
	var st v3State
	if err := json.Unmarshal(raw, &st); err != nil {
		return nil, err
	}
	if st.CommittedBatches == nil {
		st.CommittedBatches = map[string]string{}
	}
	return &st, nil
}

func (s *relay) newV3StateLocked() (*v3State, error) {
	if err := os.MkdirAll(s.v3BlobsDir(), 0700); err != nil {
		return nil, err
	}
	if err := syncDirectory(s.dir); err != nil {
		return nil, err
	}
	epoch, err := randomHex(16)
	if err != nil {
		return nil, err
	}
	return &v3State{
		Protocol:         3,
		Epoch:            epoch,
		RelayVersion:     0,
		LastSeq:          0,
		CommittedBatches: map[string]string{},
	}, nil
}

func (s *relay) saveV3StateLocked(st *v3State) error {
	// Bound remembered batch keys so long-running relays stay tiny.
	if len(st.CommittedBatches) > 2048 {
		st.CommittedBatches = map[string]string{}
	}
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(s.v3Dir(), s.v3StatePath(), append(data, '\n'))
}

func (s *relay) loadV3ObjectsLocked() (map[string]*v3ObjectRecord, error) {
	raw, err := os.ReadFile(s.v3ObjectsPath())
	if errors.Is(err, os.ErrNotExist) {
		return map[string]*v3ObjectRecord{}, nil
	}
	if err != nil {
		return nil, err
	}
	var objs map[string]*v3ObjectRecord
	if err := json.Unmarshal(raw, &objs); err != nil {
		return nil, err
	}
	if objs == nil {
		objs = map[string]*v3ObjectRecord{}
	}
	return objs, nil
}

func (s *relay) saveV3ObjectsLocked(objs map[string]*v3ObjectRecord) error {
	data, err := json.Marshal(objs)
	if err != nil {
		return err
	}
	return atomicWriteFile(s.v3Dir(), s.v3ObjectsPath(), data)
}

func v3ObjectKey(objectType, bankID, objectID string) string {
	return objectType + "\x00" + bankID + "\x00" + objectID
}

func extractItemBlobHashes(payload map[string]any) []string {
	if payload == nil {
		return nil
	}
	rawBlobs, ok := payload["blobs"].([]any)
	if !ok || len(rawBlobs) == 0 {
		return nil
	}
	var hashes []string
	for _, entry := range rawBlobs {
		m, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		sha, _ := m["sha256"].(string)
		if hashPattern.MatchString(sha) {
			hashes = append(hashes, sha)
		}
	}
	return hashes
}

func (s *relay) handleV3Status(w http.ResponseWriter, r *http.Request, _ *authPrincipal) {
	s.v3Mu.Lock()
	defer s.v3Mu.Unlock()

	st, err := s.loadV3StateLocked()
	if errors.Is(err, os.ErrNotExist) {
		w.Header().Set("X-Hindsight-Relay-Protocol", "3")
		w.Header().Set("X-Hindsight-Relay-Version", "0")
		w.Header().Set("X-Hindsight-Last-Seq", "0")
		w.Header().Set("X-Hindsight-Relay-Epoch", "")
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"protocol":       3,
			"initialized":    false,
			"epoch":          "",
			"relay_version":  0,
			"last_seq":       0,
			"active_objects": 0,
			"tombstones":     0,
		})
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	w.Header().Set("X-Hindsight-Relay-Protocol", "3")
	w.Header().Set("X-Hindsight-Relay-Epoch", st.Epoch)
	w.Header().Set("X-Hindsight-Relay-Version", strconv.FormatInt(st.RelayVersion, 10))
	w.Header().Set("X-Hindsight-Last-Seq", strconv.FormatInt(st.LastSeq, 10))
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	objs, err := s.loadV3ObjectsLocked()
	if err != nil {
		internalError(w, err)
		return
	}
	active, tombstones := 0, 0
	for _, rec := range objs {
		if rec.Deleted {
			tombstones++
		} else {
			active++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"protocol":       3,
		"initialized":    true,
		"epoch":          st.Epoch,
		"relay_version":  st.RelayVersion,
		"last_seq":       st.LastSeq,
		"active_objects": active,
		"tombstones":     tombstones,
	})
}

func (s *relay) handleV3Bootstrap(w http.ResponseWriter, r *http.Request, principal *authPrincipal) {
	var req struct {
		DeviceID      string       `json:"device_id"`
		ClientBatchID string       `json:"client_batch_id"`
		Items         []v3PushItem `json:"items"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxV3BodyBytes)).Decode(&req); err != nil {
		http.Error(w, "Invalid bootstrap request", http.StatusBadRequest)
		return
	}
	originDevice := principal.DeviceID
	if originDevice == "" {
		originDevice = strings.TrimSpace(req.DeviceID)
	}
	if originDevice == "" {
		originDevice = "legacy-shared"
	}

	s.v3Mu.Lock()
	defer s.v3Mu.Unlock()

	st, err := s.loadV3StateLocked()
	bootstrapKey := "bootstrap:" + originDevice + ":" + req.ClientBatchID
	if err == nil {
		if cached, ok := st.CommittedBatches[bootstrapKey]; ok && req.ClientBatchID != "" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, cached)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"initialized_by_self": false,
			"epoch":               st.Epoch,
			"relay_version":       st.RelayVersion,
			"last_seq":            st.LastSeq,
		})
		return
	}
	if !errors.Is(err, os.ErrNotExist) {
		internalError(w, err)
		return
	}
	st, err = s.newV3StateLocked()
	if err != nil {
		internalError(w, err)
		return
	}
	objs := make(map[string]*v3ObjectRecord)
	accepted, conflicts, missingBlobs, newLog, err := s.applyV3PushLocked(st, objs, originDevice, req.Items)
	if err != nil {
		internalError(w, err)
		return
	}
	if len(missingBlobs) > 0 {
		writeJSON(w, http.StatusFailedDependency, map[string]any{"missing_blobs": missingBlobs})
		return
	}
	response := map[string]any{
		"initialized_by_self": true,
		"epoch":               st.Epoch,
		"relay_version":       st.RelayVersion,
		"last_seq":            st.LastSeq,
		"accepted":            accepted,
		"conflicts":           conflicts,
	}
	if req.ClientBatchID != "" {
		data, err := json.Marshal(response)
		if err != nil {
			internalError(w, err)
			return
		}
		st.CommittedBatches[bootstrapKey] = string(data)
	}
	if err := s.commitV3Locked(st, objs, newLog); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *relay) applyV3PushLocked(
	st *v3State,
	objs map[string]*v3ObjectRecord,
	originDevice string,
	items []v3PushItem,
) ([]v3AcceptedItem, []v3ConflictItem, []string, []v3ChangeLogEntry, error) {
	missingSet := map[string]bool{}
	for _, item := range items {
		if item.Op == "delete" {
			continue
		}
		for _, sha := range extractItemBlobHashes(item.Payload) {
			blobPath := filepath.Join(s.v3BlobsDir(), sha)
			if _, err := os.Stat(blobPath); errors.Is(err, os.ErrNotExist) {
				missingSet[sha] = true
			} else if err != nil {
				return nil, nil, nil, nil, err
			}
		}
	}
	if len(missingSet) > 0 {
		missing := make([]string, 0, len(missingSet))
		for sha := range missingSet {
			missing = append(missing, sha)
		}
		sort.Strings(missing)
		return nil, nil, missing, nil, nil
	}

	accepted := make([]v3AcceptedItem, 0, len(items))
	conflicts := make([]v3ConflictItem, 0)
	newLog := make([]v3ChangeLogEntry, 0, len(items))
	now := time.Now().UTC().Format(time.RFC3339Nano)

	for _, item := range items {
		key := v3ObjectKey(item.ObjectType, item.BankID, item.ObjectID)
		existing := objs[key]
		isDelete := item.Op == "delete"
		if existing != nil {
			// Idempotent retry: identical content/deletion already committed.
			if existing.Deleted == isDelete && existing.ContentHash == item.ContentHash {
				accepted = append(accepted, v3AcceptedItem{
					ClientSeq:    item.ClientSeq,
					ObjectType:   item.ObjectType,
					BankID:       item.BankID,
					ObjectID:     item.ObjectID,
					Seq:          existing.Seq,
					RelayVersion: existing.RelayVersion,
					ContentHash:  existing.ContentHash,
					Deleted:      existing.Deleted,
				})
				continue
			}
			// Conflict if relay object version diverged from caller's base_relay_version.
			if item.BaseRelayVersion != existing.RelayVersion {
				conflicts = append(conflicts, v3ConflictItem{
					ClientSeq:        item.ClientSeq,
					ObjectType:       item.ObjectType,
					BankID:           item.BankID,
					ObjectID:         item.ObjectID,
					LocalVersion:     item.LocalVersion,
					BaseRelayVersion: item.BaseRelayVersion,
					RelayVersion:     existing.RelayVersion,
					RelayOp:          existing.Op,
					RelayContentHash: existing.ContentHash,
					RelayDeleted:     existing.Deleted,
					RelayPayload:     existing.Payload,
					RelayDeviceID:    existing.OriginDeviceID,
					RelaySeq:         existing.Seq,
				})
				continue
			}
		} else if item.BaseRelayVersion != 0 {
			// Caller expected a version > 0 that doesn't exist.
			conflicts = append(conflicts, v3ConflictItem{
				ClientSeq:        item.ClientSeq,
				ObjectType:       item.ObjectType,
				BankID:           item.BankID,
				ObjectID:         item.ObjectID,
				LocalVersion:     item.LocalVersion,
				BaseRelayVersion: item.BaseRelayVersion,
				RelayVersion:     0,
				RelayOp:          "delete",
				RelayContentHash: "deleted",
				RelayDeleted:     true,
				RelayPayload:     nil,
				RelayDeviceID:    "",
				RelaySeq:         0,
			})
			continue
		}

		st.LastSeq++
		st.RelayVersion++
		var nextObjVersion int64 = 1
		if existing != nil {
			nextObjVersion = existing.RelayVersion + 1
		}
		rec := &v3ObjectRecord{
			ObjectType:     item.ObjectType,
			BankID:         item.BankID,
			ObjectID:       item.ObjectID,
			Op:             item.Op,
			RelayVersion:   nextObjVersion,
			Seq:            st.LastSeq,
			ContentHash:    item.ContentHash,
			Deleted:        isDelete,
			Payload:        item.Payload,
			OriginDeviceID: originDevice,
			UpdatedAt:      now,
		}
		if isDelete {
			rec.Payload = nil
		}
		objs[key] = rec
		newLog = append(newLog, v3ChangeLogEntry{
			Seq:              st.LastSeq,
			ObjectType:       item.ObjectType,
			BankID:           item.BankID,
			ObjectID:         item.ObjectID,
			Op:               item.Op,
			RelayVersion:     nextObjVersion,
			BaseRelayVersion: item.BaseRelayVersion,
			ContentHash:      item.ContentHash,
			Deleted:          isDelete,
			Payload:          rec.Payload,
			OriginDeviceID:   originDevice,
			UpdatedAt:        now,
		})
		accepted = append(accepted, v3AcceptedItem{
			ClientSeq:    item.ClientSeq,
			ObjectType:   item.ObjectType,
			BankID:       item.BankID,
			ObjectID:     item.ObjectID,
			Seq:          st.LastSeq,
			RelayVersion: nextObjVersion,
			ContentHash:  item.ContentHash,
			Deleted:      isDelete,
		})
	}
	return accepted, conflicts, nil, newLog, nil
}

func (s *relay) handleV3PostChanges(w http.ResponseWriter, r *http.Request, principal *authPrincipal) {
	var req struct {
		DeviceID      string       `json:"device_id"`
		ClientBatchID string       `json:"client_batch_id"`
		ExpectedEpoch string       `json:"expected_epoch"`
		Items         []v3PushItem `json:"items"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxV3BodyBytes)).Decode(&req); err != nil {
		http.Error(w, "Invalid change batch", http.StatusBadRequest)
		return
	}
	originDevice := principal.DeviceID
	if originDevice == "" {
		originDevice = strings.TrimSpace(req.DeviceID)
	}
	if originDevice == "" {
		originDevice = "legacy-shared"
	}

	s.v3Mu.Lock()
	defer s.v3Mu.Unlock()

	st, err := s.loadV3StateLocked()
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "Initialize v3 before submitting changes", http.StatusConflict)
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	if req.ExpectedEpoch != "" && req.ExpectedEpoch != st.Epoch {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":         "epoch_mismatch",
			"epoch":         st.Epoch,
			"relay_version": st.RelayVersion,
			"last_seq":      st.LastSeq,
		})
		return
	}
	if req.ClientBatchID != "" {
		batchKey := originDevice + ":" + req.ClientBatchID
		if cachedResp, ok := st.CommittedBatches[batchKey]; ok {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(cachedResp))
			return
		}
	}

	objs, err := s.loadV3ObjectsLocked()
	if err != nil {
		internalError(w, err)
		return
	}
	accepted, conflicts, missingBlobs, newLog, err := s.applyV3PushLocked(st, objs, originDevice, req.Items)
	if err != nil {
		internalError(w, err)
		return
	}
	if len(missingBlobs) > 0 {
		writeJSON(w, http.StatusFailedDependency, map[string]any{"missing_blobs": missingBlobs})
		return
	}

	respObj := map[string]any{
		"epoch":           st.Epoch,
		"relay_version":   st.RelayVersion,
		"last_seq":        st.LastSeq,
		"accepted":        accepted,
		"conflicts":       conflicts,
		"duplicate_batch": false,
	}
	if req.ClientBatchID != "" {
		dupObj := map[string]any{
			"epoch":           st.Epoch,
			"relay_version":   st.RelayVersion,
			"last_seq":        st.LastSeq,
			"accepted":        accepted,
			"conflicts":       conflicts,
			"duplicate_batch": true,
		}
		if dupRaw, mErr := json.Marshal(dupObj); mErr == nil {
			st.CommittedBatches[originDevice+":"+req.ClientBatchID] = string(dupRaw)
		}
	}
	if len(newLog) > 0 || req.ClientBatchID != "" {
		if err := s.commitV3Locked(st, objs, newLog); err != nil {
			internalError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, respObj)
}

func (s *relay) handleV3GetChanges(w http.ResponseWriter, r *http.Request, _ *authPrincipal) {
	q := r.URL.Query()
	afterSeq, _ := strconv.ParseInt(q.Get("after_seq"), 10, 64)
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	maxBytes, _ := strconv.Atoi(q.Get("max_bytes"))
	if maxBytes <= 0 {
		maxBytes = 8 * 1024 * 1024
	}
	clientEpoch := q.Get("epoch")

	s.v3Mu.Lock()
	defer s.v3Mu.Unlock()

	st, err := s.loadV3StateLocked()
	if errors.Is(err, os.ErrNotExist) {
		writeJSON(w, http.StatusOK, map[string]any{
			"epoch":          "",
			"relay_version":  0,
			"last_seq":       0,
			"reset_required": false,
			"next_seq":       0,
			"has_more":       false,
			"changes":        []v3ChangeLogEntry{},
		})
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	if clientEpoch != "" && clientEpoch != st.Epoch {
		writeJSON(w, http.StatusOK, map[string]any{
			"epoch":          st.Epoch,
			"relay_version":  st.RelayVersion,
			"last_seq":       st.LastSeq,
			"reset_required": true,
			"next_seq":       st.LastSeq,
			"has_more":       false,
			"changes":        []v3ChangeLogEntry{},
		})
		return
	}
	if afterSeq < 0 || afterSeq > st.LastSeq {
		writeJSON(w, http.StatusOK, map[string]any{
			"epoch":          st.Epoch,
			"relay_version":  st.RelayVersion,
			"last_seq":       st.LastSeq,
			"reset_required": true,
			"next_seq":       st.LastSeq,
			"has_more":       false,
			"changes":        []v3ChangeLogEntry{},
		})
		return
	}

	changes := make([]v3ChangeLogEntry, 0)
	nextSeq := afterSeq
	hasMore := false

	f, err := os.Open(s.v3ChangesPath())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		internalError(w, err)
		return
	}
	if err == nil {
		defer f.Close()
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 64*1024), maxV3BodyBytes)
		totalBytes := 0
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}
			var entry v3ChangeLogEntry
			if err := json.Unmarshal(line, &entry); err != nil {
				internalError(w, err)
				return
			}
			if entry.Seq <= afterSeq {
				continue
			}
			if len(changes) >= limit || (len(changes) > 0 && totalBytes+len(line) > maxBytes) {
				hasMore = true
				break
			}
			changes = append(changes, entry)
			nextSeq = entry.Seq
			totalBytes += len(line)
		}
		if err := scanner.Err(); err != nil {
			internalError(w, err)
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"epoch":          st.Epoch,
		"relay_version":  st.RelayVersion,
		"last_seq":       st.LastSeq,
		"reset_required": false,
		"next_seq":       nextSeq,
		"has_more":       hasMore,
		"changes":        changes,
	})
}

func (s *relay) handleV3Baseline(w http.ResponseWriter, r *http.Request, _ *authPrincipal) {
	q := r.URL.Query()
	offset, _ := strconv.Atoi(q.Get("offset"))
	if offset < 0 {
		offset = 0
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 200
	}

	s.v3Mu.Lock()
	defer s.v3Mu.Unlock()

	st, err := s.loadV3StateLocked()
	if errors.Is(err, os.ErrNotExist) {
		writeJSON(w, http.StatusOK, map[string]any{
			"epoch":         "",
			"relay_version": 0,
			"last_seq":      0,
			"total":         0,
			"offset":        0,
			"limit":         limit,
			"items":         []*v3ObjectRecord{},
		})
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	if epoch := q.Get("epoch"); epoch != "" {
		seq, err := strconv.ParseInt(q.Get("last_seq"), 10, 64)
		if err != nil || epoch != st.Epoch || seq != st.LastSeq {
			http.Error(w, "Baseline changed; restart from the first page", http.StatusConflict)
			return
		}
	}
	objs, err := s.loadV3ObjectsLocked()
	if err != nil {
		internalError(w, err)
		return
	}
	all := make([]*v3ObjectRecord, 0, len(objs))
	for _, rec := range objs {
		all = append(all, rec)
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].Seq != all[j].Seq {
			return all[i].Seq < all[j].Seq
		}
		return all[i].ObjectID < all[j].ObjectID
	})
	total := len(all)
	end := offset + limit
	if offset > total {
		offset = total
	}
	if end > total {
		end = total
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"epoch":         st.Epoch,
		"relay_version": st.RelayVersion,
		"last_seq":      st.LastSeq,
		"total":         total,
		"offset":        offset,
		"limit":         limit,
		"items":         all[offset:end],
	})
}

func (s *relay) handleV3BlobsMissing(w http.ResponseWriter, r *http.Request, _ *authPrincipal) {
	var req struct {
		Hashes []string `json:"hashes"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*1024*1024)).Decode(&req); err != nil {
		http.Error(w, "Invalid blob list", http.StatusBadRequest)
		return
	}
	missing := make([]string, 0)
	seen := map[string]bool{}
	for _, h := range req.Hashes {
		if !hashPattern.MatchString(h) || seen[h] {
			continue
		}
		seen[h] = true
		if _, err := os.Stat(filepath.Join(s.v3BlobsDir(), h)); errors.Is(err, os.ErrNotExist) {
			missing = append(missing, h)
		} else if err != nil {
			internalError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"missing": missing})
}

func (s *relay) handleV3Blob(w http.ResponseWriter, r *http.Request, _ *authPrincipal) {
	sha := strings.TrimPrefix(r.URL.Path, v3BlobsPrefix)
	if !hashPattern.MatchString(sha) {
		http.Error(w, "Invalid blob digest", http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(s.v3BlobsDir(), 0700); err != nil {
		internalError(w, err)
		return
	}
	target := filepath.Join(s.v3BlobsDir(), sha)

	switch r.Method {
	case http.MethodHead, http.MethodGet:
		f, err := os.Open(target)
		if errors.Is(err, os.ErrNotExist) {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if err != nil {
			internalError(w, err)
			return
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			internalError(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			_, _ = io.Copy(w, f)
		}
	case http.MethodPut:
		if r.ContentLength > s.maxBytes {
			http.Error(w, "Blob exceeds the size limit", http.StatusRequestEntityTooLarge)
			return
		}
		tmp, err := os.CreateTemp(s.v3BlobsDir(), ".blob-*")
		if err != nil {
			internalError(w, err)
			return
		}
		tmpName := tmp.Name()
		cleanup := true
		defer func() {
			if cleanup {
				_ = os.Remove(tmpName)
			}
		}()
		digest := sha256.New()
		body := http.MaxBytesReader(w, r.Body, s.maxBytes)
		if _, err := io.Copy(io.MultiWriter(tmp, digest), body); err != nil {
			_ = tmp.Close()
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				http.Error(w, "Blob exceeds the size limit", http.StatusRequestEntityTooLarge)
				return
			}
			http.Error(w, "Incomplete blob upload", http.StatusBadRequest)
			return
		}
		actual := hex.EncodeToString(digest.Sum(nil))
		if actual != sha {
			_ = tmp.Close()
			http.Error(w, "Blob SHA-256 mismatch", http.StatusUnprocessableEntity)
			return
		}
		if err := tmp.Sync(); err != nil {
			_ = tmp.Close()
			internalError(w, err)
			return
		}
		if err := tmp.Close(); err != nil {
			internalError(w, err)
			return
		}
		if err := os.Rename(tmpName, target); err != nil {
			internalError(w, err)
			return
		}
		cleanup = false
		if err := syncDirectory(s.v3BlobsDir()); err != nil {
			internalError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}
