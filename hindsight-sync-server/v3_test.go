package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRelayV3SyncConflictsAndBlobs(t *testing.T) {
	s, err := newRelay(t.TempDir(), testToken, defaultMaxRelayBytes)
	if err != nil {
		t.Fatal(err)
	}
	handler := s.handler()

	boot := apiJSON(t, handler, http.MethodPost, v3BootstrapPath, testToken, "dev-a", map[string]any{
		"device_id": "dev-a",
		"items":     []any{},
	})
	if boot.Code != http.StatusOK {
		t.Fatalf("bootstrap failed: %d %s", boot.Code, boot.Body.String())
	}

	blobBytes := []byte("attachment-bytes")
	blobSum := sha256.Sum256(blobBytes)
	blobHex := hex.EncodeToString(blobSum[:])

	// Push referencing missing blob returns 424.
	pushMissing := apiJSON(t, handler, http.MethodPost, v3ChangesPath, testToken, "dev-a", map[string]any{
		"client_batch_id": "batch-1",
		"items": []map[string]any{{
			"client_seq":         1,
			"object_type":        "document",
			"bank_id":            "bank-1",
			"object_id":          "doc-1",
			"op":                 "upsert",
			"local_version":      1,
			"base_relay_version": 0,
			"content_hash":       strings.Repeat("a", 64),
			"payload": map[string]any{
				"blobs": []map[string]any{{"storage_key": "k", "sha256": blobHex, "byte_size": len(blobBytes)}},
			},
		}},
	})
	if pushMissing.Code != http.StatusFailedDependency {
		t.Fatalf("expected 424 when blob missing, got %d", pushMissing.Code)
	}

	// Upload blob then re-submit batch-1.
	putReq := httptest.NewRequest(http.MethodPut, v3BlobsPrefix+blobHex, strings.NewReader(string(blobBytes)))
	putReq.Header.Set("Authorization", "Bearer "+testToken)
	putRec := httptest.NewRecorder()
	handler.ServeHTTP(putRec, putReq)
	if putRec.Code != http.StatusNoContent {
		t.Fatalf("blob upload failed: %d", putRec.Code)
	}

	pushOK := apiJSON(t, handler, http.MethodPost, v3ChangesPath, testToken, "dev-a", map[string]any{
		"client_batch_id": "batch-1",
		"items": []map[string]any{{
			"client_seq":         1,
			"object_type":        "document",
			"bank_id":            "bank-1",
			"object_id":          "doc-1",
			"op":                 "upsert",
			"local_version":      1,
			"base_relay_version": 0,
			"content_hash":       strings.Repeat("a", 64),
			"payload": map[string]any{
				"id":    "doc-1",
				"blobs": []map[string]any{{"storage_key": "k", "sha256": blobHex, "byte_size": len(blobBytes)}},
			},
		}},
	})
	if pushOK.Code != http.StatusOK {
		t.Fatalf("push batch-1 failed: %d %s", pushOK.Code, pushOK.Body.String())
	}

	// Idempotent batch retry does not advance relay_version.
	dup := apiJSON(t, handler, http.MethodPost, v3ChangesPath, testToken, "dev-a", map[string]any{
		"client_batch_id": "batch-1",
		"items":           []map[string]any{},
	})
	var dupBody map[string]any
	_ = json.Unmarshal(dup.Body.Bytes(), &dupBody)
	if dupBody["duplicate_batch"] != true || int(dupBody["last_seq"].(float64)) != 1 {
		t.Fatalf("expected duplicate_batch=true with last_seq=1, got %v", dupBody)
	}

	// Stale base from another device triggers per-object conflict while allowing disjoint objects.
	conflictPush := apiJSON(t, handler, http.MethodPost, v3ChangesPath, testToken, "dev-b", map[string]any{
		"client_batch_id": "batch-b1",
		"items": []map[string]any{
			{
				"client_seq":         1,
				"object_type":        "document",
				"bank_id":            "bank-1",
				"object_id":          "doc-1",
				"op":                 "upsert",
				"local_version":      1,
				"base_relay_version": 0,
				"content_hash":       strings.Repeat("b", 64),
				"payload":            map[string]any{"id": "doc-1"},
			},
			{
				"client_seq":         2,
				"object_type":        "working_rule",
				"bank_id":            "",
				"object_id":          "rule-1",
				"op":                 "upsert",
				"local_version":      1,
				"base_relay_version": 0,
				"content_hash":       strings.Repeat("c", 64),
				"payload":            map[string]any{"id": "rule-1", "content": "Rule B"},
			},
		},
	})
	var cBody map[string]any
	_ = json.Unmarshal(conflictPush.Body.Bytes(), &cBody)
	if len(cBody["accepted"].([]any)) != 1 || len(cBody["conflicts"].([]any)) != 1 {
		t.Fatalf("expected 1 accepted and 1 conflict, got %v", cBody)
	}
}
