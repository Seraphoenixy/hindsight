package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func apiJSON(t *testing.T, handler http.Handler, method, path, token, deviceID string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if deviceID != "" {
		req.Header.Set("X-Hindsight-Device-Id", deviceID)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestRelayDeviceLifecycleAndRevocation(t *testing.T) {
	s, err := newRelay(t.TempDir(), testToken, defaultMaxRelayBytes)
	if err != nil {
		t.Fatal(err)
	}
	handler := s.handler()

	regA := apiJSON(t, handler, http.MethodPost, devicesPath, testToken, "", map[string]string{
		"device_id": "dev-alpha",
		"name":      "Alpha Laptop",
	})
	if regA.Code != http.StatusCreated {
		t.Fatalf("register A: %d %s", regA.Code, regA.Body.String())
	}
	var devA map[string]any
	_ = json.Unmarshal(regA.Body.Bytes(), &devA)
	tokenA := devA["token"].(string)

	// Device token can read v3 status, cannot register devices.
	if st := apiJSON(t, handler, http.MethodGet, v3StatusPath, tokenA, "", nil); st.Code != http.StatusOK {
		t.Fatalf("status with device token: %d", st.Code)
	}
	if deny := apiJSON(t, handler, http.MethodPost, devicesPath, tokenA, "", map[string]string{"name": "X"}); deny.Code != http.StatusForbidden {
		t.Fatalf("non-admin register should fail 403, got %d", deny.Code)
	}

	// Rotate invalidates old token immediately.
	rot := apiJSON(t, handler, http.MethodPost, "/v3/devices/dev-alpha/rotate", testToken, "", nil)
	if rot.Code != http.StatusOK {
		t.Fatalf("rotate A: %d %s", rot.Code, rot.Body.String())
	}
	var rotBody map[string]any
	_ = json.Unmarshal(rot.Body.Bytes(), &rotBody)
	newTokenA := rotBody["token"].(string)
	if newTokenA == tokenA {
		t.Fatal("rotated token matched old token")
	}
	if oldResp := apiJSON(t, handler, http.MethodGet, v3StatusPath, tokenA, "", nil); oldResp.Code != http.StatusUnauthorized {
		t.Fatalf("old token should fail 401, got %d", oldResp.Code)
	}
	if newResp := apiJSON(t, handler, http.MethodGet, v3StatusPath, newTokenA, "", nil); newResp.Code != http.StatusOK {
		t.Fatalf("new token should succeed, got %d", newResp.Code)
	}

	// Revoke returns 403 on subsequent sync attempts.
	rev := apiJSON(t, handler, http.MethodPost, "/v3/devices/dev-alpha/revoke", testToken, "", nil)
	if rev.Code != http.StatusOK {
		t.Fatalf("revoke A: %d", rev.Code)
	}
	if blocked := apiJSON(t, handler, http.MethodGet, v3StatusPath, newTokenA, "", nil); blocked.Code != http.StatusForbidden {
		t.Fatalf("revoked device should receive 403, got %d", blocked.Code)
	}
}
