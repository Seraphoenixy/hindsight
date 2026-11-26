package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	devicesPath        = "/v3/devices"
	devicesActionPath  = "/v3/devices/"
	deviceTokenBytes   = 36
	deviceStoreVersion = 1
)

var (
	deviceIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	errUnauthorized = errors.New("invalid sync token")
	errForbidden    = errors.New("device credential revoked")
)

type deviceRecord struct {
	DeviceID   string `json:"device_id"`
	Name       string `json:"name"`
	TokenHash  string `json:"token_hash,omitempty"`
	CreatedAt  string `json:"created_at"`
	RotatedAt  string `json:"rotated_at,omitempty"`
	RevokedAt  string `json:"revoked_at,omitempty"`
	LastSeenAt string `json:"last_seen_at,omitempty"`
}

type publicDeviceView struct {
	DeviceID   string `json:"device_id"`
	Name       string `json:"name"`
	CreatedAt  string `json:"created_at"`
	RotatedAt  string `json:"rotated_at,omitempty"`
	RevokedAt  string `json:"revoked_at,omitempty"`
	LastSeenAt string `json:"last_seen_at,omitempty"`
	Active     bool   `json:"active"`
}

type provisionedDevice struct {
	DeviceID  string `json:"device_id"`
	Name      string `json:"name"`
	Token     string `json:"token"`
	CreatedAt string `json:"created_at"`
	Active    bool   `json:"active"`
}

type deviceRegistry struct {
	Version int                      `json:"version"`
	Devices map[string]*deviceRecord `json:"devices"`
}

type authPrincipal struct {
	IsAdmin  bool
	DeviceID string
}

func (s *relay) v3Dir() string {
	return filepath.Join(s.dir, "v3")
}

func (s *relay) devicesFilePath() string {
	return filepath.Join(s.v3Dir(), "devices.json")
}

func (s *relay) loadDeviceRegistryLocked() (*deviceRegistry, error) {
	raw, err := os.ReadFile(s.devicesFilePath())
	if errors.Is(err, os.ErrNotExist) {
		return &deviceRegistry{Version: deviceStoreVersion, Devices: map[string]*deviceRecord{}}, nil
	}
	if err != nil {
		return nil, err
	}
	var reg deviceRegistry
	if err := json.Unmarshal(raw, &reg); err != nil {
		return nil, err
	}
	if reg.Devices == nil {
		reg.Devices = map[string]*deviceRecord{}
	}
	return &reg, nil
}

func (s *relay) saveDeviceRegistryLocked(reg *deviceRegistry) error {
	if err := os.MkdirAll(s.v3Dir(), 0700); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(reg, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(s.v3Dir(), s.devicesFilePath(), append(payload, '\n'))
}

func generateDeviceToken() (string, string, error) {
	buf := make([]byte, deviceTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	token := "hds_" + base64.RawURLEncoding.EncodeToString(buf)
	sum := sha256.Sum256([]byte("Bearer " + token))
	return token, hex.EncodeToString(sum[:]), nil
}

func randomHex(nBytes int) (string, error) {
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func (s *relay) authenticateRequest(r *http.Request) (*authPrincipal, error) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
		return nil, errUnauthorized
	}
	providedBytes := sha256.Sum256([]byte(authHeader))
	claimedDevice := strings.TrimSpace(r.Header.Get("X-Hindsight-Device-Id"))

	if subtle.ConstantTimeCompare(s.token[:], providedBytes[:]) == 1 {
		if claimedDevice != "" {
			s.v3Mu.Lock()
			reg, err := s.loadDeviceRegistryLocked()
			s.v3Mu.Unlock()
			if err == nil {
				if rec, ok := reg.Devices[claimedDevice]; ok && rec.RevokedAt != "" {
					return nil, errForbidden
				}
			}
		}
		return &authPrincipal{IsAdmin: true, DeviceID: claimedDevice}, nil
	}

	providedHex := hex.EncodeToString(providedBytes[:])
	s.v3Mu.Lock()
	defer s.v3Mu.Unlock()
	reg, err := s.loadDeviceRegistryLocked()
	if err != nil {
		return nil, errUnauthorized
	}
	var matched *deviceRecord
	for _, rec := range reg.Devices {
		if rec.TokenHash == "" {
			continue
		}
		if len(rec.TokenHash) == len(providedHex) && subtle.ConstantTimeCompare([]byte(rec.TokenHash), []byte(providedHex)) == 1 {
			matched = rec
			break
		}
	}
	if matched == nil {
		return nil, errUnauthorized
	}
	if matched.RevokedAt != "" {
		return nil, errForbidden
	}
	matched.LastSeenAt = time.Now().UTC().Format(time.RFC3339Nano)
	_ = s.saveDeviceRegistryLocked(reg)
	return &authPrincipal{IsAdmin: false, DeviceID: matched.DeviceID}, nil
}

func (s *relay) authenticateV3(next func(http.ResponseWriter, *http.Request, *authPrincipal)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		principal, err := s.authenticateRequest(r)
		if err != nil {
			if errors.Is(err, errForbidden) {
				http.Error(w, "Device credential revoked", http.StatusForbidden)
				return
			}
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "Invalid sync token", http.StatusUnauthorized)
			return
		}
		next(w, r, principal)
	}
}

func toPublicDeviceView(rec *deviceRecord) publicDeviceView {
	return publicDeviceView{
		DeviceID:   rec.DeviceID,
		Name:       rec.Name,
		CreatedAt:  rec.CreatedAt,
		RotatedAt:  rec.RotatedAt,
		RevokedAt:  rec.RevokedAt,
		LastSeenAt: rec.LastSeenAt,
		Active:     rec.RevokedAt == "",
	}
}

func (s *relay) handleDevicesList(w http.ResponseWriter, _ *http.Request, principal *authPrincipal) {
	if !principal.IsAdmin {
		http.Error(w, "Admin token required", http.StatusForbidden)
		return
	}
	s.v3Mu.Lock()
	defer s.v3Mu.Unlock()
	reg, err := s.loadDeviceRegistryLocked()
	if err != nil {
		internalError(w, err)
		return
	}
	items := make([]publicDeviceView, 0, len(reg.Devices))
	for _, rec := range reg.Devices {
		items = append(items, toPublicDeviceView(rec))
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt == items[j].CreatedAt {
			return items[i].DeviceID < items[j].DeviceID
		}
		return items[i].CreatedAt < items[j].CreatedAt
	})
	writeJSON(w, http.StatusOK, map[string]any{"devices": items, "total": len(items)})
}

func (s *relay) handleDevicesRegister(w http.ResponseWriter, r *http.Request, principal *authPrincipal) {
	if !principal.IsAdmin {
		http.Error(w, "Admin token required to register devices", http.StatusForbidden)
		return
	}
	var req struct {
		DeviceID string `json:"device_id"`
		Name     string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
		http.Error(w, "Invalid device payload", http.StatusBadRequest)
		return
	}
	deviceID := strings.TrimSpace(req.DeviceID)
	if deviceID == "" {
		suffix, err := randomHex(8)
		if err != nil {
			internalError(w, err)
			return
		}
		deviceID = "dev-" + suffix
	}
	if !deviceIDPattern.MatchString(deviceID) {
		http.Error(w, "Invalid device_id", http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = deviceID
	}

	s.v3Mu.Lock()
	defer s.v3Mu.Unlock()
	reg, err := s.loadDeviceRegistryLocked()
	if err != nil {
		internalError(w, err)
		return
	}
	if existing, exists := reg.Devices[deviceID]; exists && existing.RevokedAt == "" {
		http.Error(w, "Device already registered", http.StatusConflict)
		return
	}
	device, err := s.issueDeviceLocked(reg, deviceID, name)
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, device)
}

func (s *relay) issueDeviceLocked(reg *deviceRegistry, deviceID, name string) (provisionedDevice, error) {
	token, tokenHash, err := generateDeviceToken()
	if err != nil {
		return provisionedDevice{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	rec := &deviceRecord{
		DeviceID:  deviceID,
		Name:      name,
		TokenHash: tokenHash,
		CreatedAt: now,
		RotatedAt: now,
	}
	reg.Devices[deviceID] = rec
	if err := s.saveDeviceRegistryLocked(reg); err != nil {
		return provisionedDevice{}, err
	}
	return provisionedDevice{rec.DeviceID, rec.Name, token, rec.CreatedAt, true}, nil
}

func (s *relay) handleDeviceAction(w http.ResponseWriter, r *http.Request, principal *authPrincipal) {
	rest := strings.TrimPrefix(r.URL.Path, devicesActionPath)
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || !deviceIDPattern.MatchString(parts[0]) {
		http.NotFound(w, r)
		return
	}
	deviceID, action := parts[0], parts[1]
	switch action {
	case "rotate":
		if !principal.IsAdmin && principal.DeviceID != deviceID {
			http.Error(w, "Not authorized to rotate this device", http.StatusForbidden)
			return
		}
		token, tokenHash, err := generateDeviceToken()
		if err != nil {
			internalError(w, err)
			return
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		s.v3Mu.Lock()
		defer s.v3Mu.Unlock()
		reg, err := s.loadDeviceRegistryLocked()
		if err != nil {
			internalError(w, err)
			return
		}
		rec, ok := reg.Devices[deviceID]
		if !ok {
			http.NotFound(w, r)
			return
		}
		if rec.RevokedAt != "" {
			http.Error(w, "Cannot rotate a revoked device", http.StatusForbidden)
			return
		}
		rec.TokenHash = tokenHash
		rec.RotatedAt = now
		if err := s.saveDeviceRegistryLocked(reg); err != nil {
			internalError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"device_id":  rec.DeviceID,
			"name":       rec.Name,
			"token":      token,
			"rotated_at": now,
			"active":     true,
		})
	case "revoke":
		if !principal.IsAdmin {
			http.Error(w, "Admin token required to revoke devices", http.StatusForbidden)
			return
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		s.v3Mu.Lock()
		defer s.v3Mu.Unlock()
		reg, err := s.loadDeviceRegistryLocked()
		if err != nil {
			internalError(w, err)
			return
		}
		rec, ok := reg.Devices[deviceID]
		if !ok {
			http.NotFound(w, r)
			return
		}
		if rec.RevokedAt == "" {
			rec.RevokedAt = now
		}
		if err := s.saveDeviceRegistryLocked(reg); err != nil {
			internalError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, toPublicDeviceView(rec))
	default:
		http.NotFound(w, r)
	}
}
