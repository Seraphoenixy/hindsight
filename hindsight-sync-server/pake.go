package main

import (
	"bytes"
	"crypto"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/posterity/srp"
)

const (
	pakeVersion    = "srp6a-sha256-3072-v1"
	pakeUsername   = "hindsight-sync"
	pakeIterations = 600000
	pakeLifetime   = 2 * time.Minute
	pakeWindow     = 30 * time.Second
	pakeAttempts   = 12
	pakeGroupBytes = 384
	pakeSaltBytes  = 16
)

var (
	pakeParams = srp.Params{Group: srp.RFC5054Group3072, Hash: crypto.SHA256}
	pakeUpper  = new(big.Int).Sub(pakeParams.Group.N, big.NewInt(1))
)

type pakeRecord struct {
	Protocol   string `json:"protocol"`
	AccessSalt []byte `json:"access_salt"`
	SRPSalt    []byte `json:"srp_salt"`
	Verifier   []byte `json:"verifier"`
}

type pakeChallenge struct {
	server  *srp.Server
	expires time.Time
}

type pakeState struct {
	mu         sync.Mutex
	challenges map[string]pakeChallenge
	windowEnd  time.Time
	attempts   int
}

func validPAKEGroupValue(raw []byte) bool {
	if len(raw) != pakeGroupBytes {
		return false
	}
	number := new(big.Int).SetBytes(raw)
	return number.Cmp(big.NewInt(1)) > 0 && number.Cmp(pakeUpper) < 0
}

func (record pakeRecord) valid() bool {
	return record.Protocol == pakeVersion && len(record.AccessSalt) == pakeSaltBytes &&
		len(record.SRPSalt) == pakeSaltBytes && validPAKEGroupValue(record.Verifier)
}

func decodePAKE(w http.ResponseWriter, r *http.Request, value any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	d.DisallowUnknownFields()
	if d.Decode(value) != nil || d.Decode(new(any)) != io.EOF {
		http.Error(w, "Invalid PAKE payload", http.StatusBadRequest)
		return false
	}
	return true
}

func (s *relay) pakeRecordPath() string {
	return filepath.Join(s.dir, "pake.json")
}

func (s *relay) loadPAKERecord() (pakeRecord, error) {
	var record pakeRecord
	raw, err := os.ReadFile(s.pakeRecordPath())
	if err != nil {
		return record, err
	}
	if err := json.Unmarshal(raw, &record); err != nil {
		return record, err
	}
	if !record.valid() {
		return record, errors.New("invalid stored PAKE record")
	}
	return record, nil
}

func (s *relay) handlePAKEConfig(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	config := map[string]any{"protocol": pakeVersion, "pbkdf2_iterations": pakeIterations, "initialized": false}
	record, err := s.loadPAKERecord()
	switch {
	case err == nil:
		config["initialized"] = true
		config["access_salt"] = record.AccessSalt
		config["srp_salt"] = record.SRPSalt
	case !errors.Is(err, os.ErrNotExist):
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, config)
}

func (s *relay) handlePAKEInitialize(w http.ResponseWriter, r *http.Request, principal *authPrincipal) {
	if !principal.IsAdmin {
		http.Error(w, "Admin token required", http.StatusForbidden)
		return
	}
	var record pakeRecord
	if !decodePAKE(w, r, &record) {
		return
	}
	if !record.valid() {
		http.Error(w, "Invalid PAKE registration record", http.StatusBadRequest)
		return
	}
	s.pake.mu.Lock()
	defer s.pake.mu.Unlock()
	if _, err := os.Stat(s.pakeRecordPath()); err == nil {
		http.Error(w, "PAKE is already initialized", http.StatusConflict)
		return
	} else if !errors.Is(err, os.ErrNotExist) {
		internalError(w, err)
		return
	}
	raw, err := json.Marshal(record)
	if err == nil {
		err = atomicWriteFile(s.dir, s.pakeRecordPath(), raw)
	}
	if err != nil {
		internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *relay) handlePAKEChallenge(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var req struct {
		Public []byte `json:"client_public"`
	}
	if !decodePAKE(w, r, &req) {
		return
	}
	if !validPAKEGroupValue(req.Public) {
		http.Error(w, "Authentication failed", http.StatusUnauthorized)
		return
	}
	record, err := s.loadPAKERecord()
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "Authentication failed", http.StatusUnauthorized)
		return
	}
	if err != nil {
		internalError(w, err)
		return
	}
	now := time.Now()
	state := &s.pake
	state.mu.Lock()
	defer state.mu.Unlock()
	if !now.Before(state.windowEnd) {
		state.windowEnd = now.Add(pakeWindow)
		state.attempts = 0
	}
	if state.attempts >= pakeAttempts {
		w.Header().Set("Retry-After", "30")
		http.Error(w, "Too many PAKE challenges", http.StatusTooManyRequests)
		return
	}
	state.attempts++
	if state.challenges == nil {
		state.challenges = make(map[string]pakeChallenge)
	}
	for id, challenge := range state.challenges {
		if !now.Before(challenge.expires) {
			delete(state.challenges, id)
		}
	}
	server, err := srp.NewServer(&pakeParams, pakeUsername, record.SRPSalt, record.Verifier)
	if err != nil {
		internalError(w, err)
		return
	}
	if err := server.SetA(req.Public); err != nil {
		http.Error(w, "Authentication failed", http.StatusUnauthorized)
		return
	}
	id, err := randomHex(32)
	if err != nil {
		internalError(w, err)
		return
	}
	state.challenges[id] = pakeChallenge{server: server, expires: now.Add(pakeLifetime)}
	public := new(big.Int).SetBytes(server.B()).FillBytes(make([]byte, pakeGroupBytes))
	writeJSON(w, http.StatusOK, map[string]any{"challenge_id": id, "server_public": public})
}

func (s *relay) handlePAKEVerify(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var req struct {
		Challenge string `json:"challenge_id"`
		Proof     []byte `json:"client_proof"`
		DeviceID  string `json:"device_id"`
		Name      string `json:"name"`
	}
	if !decodePAKE(w, r, &req) {
		return
	}
	s.pake.mu.Lock()
	challenge, found := s.pake.challenges[req.Challenge]
	delete(s.pake.challenges, req.Challenge)
	s.pake.mu.Unlock()
	if !found || !time.Now().Before(challenge.expires) || len(req.Proof) != sha256.Size {
		http.Error(w, "Authentication failed", http.StatusUnauthorized)
		return
	}
	valid, err := challenge.server.CheckM1(bytes.TrimLeft(req.Proof, "\x00"))
	if err != nil || !valid {
		http.Error(w, "Authentication failed", http.StatusUnauthorized)
		return
	}
	proof, err := challenge.server.ComputeM2()
	if err != nil {
		internalError(w, err)
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if !deviceIDPattern.MatchString(req.DeviceID) || len(req.Name) > 256 {
		http.Error(w, "Invalid device identity", http.StatusBadRequest)
		return
	}
	if req.Name == "" {
		req.Name = req.DeviceID
	}
	device, err := s.loginPAKEDevice(req.DeviceID, req.Name, r.Header.Get("Authorization"))
	switch {
	case errors.Is(err, errForbidden):
		http.Error(w, "Device credential revoked", http.StatusForbidden)
	case errors.Is(err, errUnauthorized):
		http.Error(w, "Current device credential required for this device ID", http.StatusConflict)
	case err != nil:
		internalError(w, err)
	default:
		writeJSON(w, http.StatusOK, struct {
			provisionedDevice
			ServerProof []byte `json:"server_proof"`
		}{device, proof})
	}
}

func (s *relay) loginPAKEDevice(id, name, authorization string) (provisionedDevice, error) {
	s.v3Mu.Lock()
	defer s.v3Mu.Unlock()
	reg, err := s.loadDeviceRegistryLocked()
	if err != nil {
		return provisionedDevice{}, err
	}
	existing := reg.Devices[id]
	if existing == nil {
		return s.issueDeviceLocked(reg, id, name)
	}
	if existing.RevokedAt != "" {
		return provisionedDevice{}, errForbidden
	}
	token, ok := strings.CutPrefix(authorization, "Bearer ")
	sum := sha256.Sum256([]byte(authorization))
	actual := hex.EncodeToString(sum[:])
	if !ok || subtle.ConstantTimeCompare([]byte(existing.TokenHash), []byte(actual)) != 1 {
		return provisionedDevice{}, errUnauthorized
	}
	return provisionedDevice{id, existing.Name, token, existing.CreatedAt, true}, nil
}
