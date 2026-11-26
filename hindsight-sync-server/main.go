package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const defaultMaxRelayBytes = 512 * 1024 * 1024

type relay struct {
	token    [32]byte
	dir      string
	maxBytes int64
	v3Mu     sync.Mutex
	pake     pakeState
}

func newRelay(dir, token string, maxBytes int64) (*relay, error) {
	if len(token) < 32 || strings.ContainsFunc(token, func(r rune) bool { return r < 33 || r > 126 }) {
		return nil, errors.New("HINDSIGHT_SYNC_TOKEN must contain at least 32 printable ASCII characters without spaces")
	}
	if maxBytes <= 0 {
		return nil, errors.New("invalid HINDSIGHT_SYNC_MAX_BYTES")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	return &relay{
		token: sha256.Sum256([]byte("Bearer " + token)), dir: dir, maxBytes: maxBytes,
	}, nil
}

func (s *relay) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("HEAD "+v3StatusPath, s.authenticateV3(s.handleV3Status))
	mux.HandleFunc("GET "+v3StatusPath, s.authenticateV3(s.handleV3Status))
	mux.HandleFunc("POST "+v3BootstrapPath, s.authenticateV3(s.handleV3Bootstrap))
	mux.HandleFunc("POST "+v3ChangesPath, s.authenticateV3(s.handleV3PostChanges))
	mux.HandleFunc("GET "+v3ChangesPath, s.authenticateV3(s.handleV3GetChanges))
	mux.HandleFunc("GET "+v3BaselinePath, s.authenticateV3(s.handleV3Baseline))
	mux.HandleFunc("POST "+v3BlobsMissingPath, s.authenticateV3(s.handleV3BlobsMissing))
	mux.HandleFunc(v3BlobsPrefix, s.authenticateV3(s.handleV3Blob))
	mux.HandleFunc("GET "+devicesPath, s.authenticateV3(s.handleDevicesList))
	mux.HandleFunc("POST "+devicesPath, s.authenticateV3(s.handleDevicesRegister))
	mux.HandleFunc("POST "+devicesActionPath, s.authenticateV3(s.handleDeviceAction))
	mux.HandleFunc("GET /v3/auth/config", s.handlePAKEConfig)
	mux.HandleFunc("POST /v3/auth/initialize", s.authenticateV3(s.handlePAKEInitialize))
	mux.HandleFunc("POST /v3/auth/login/challenge", s.handlePAKEChallenge)
	mux.HandleFunc("POST /v3/auth/login/verify", s.handlePAKEVerify)
	return mux
}

func internalError(w http.ResponseWriter, err error) {
	log.Printf("sync storage: %v", err)
	http.Error(w, "Sync storage error", http.StatusInternalServerError)
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func run() error {
	dir := os.Getenv("HINDSIGHT_SYNC_DATA_DIR")
	if dir == "" {
		root := os.Getenv("XDG_DATA_HOME")
		if root == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return err
			}
			root = filepath.Join(home, ".local", "share")
		}
		dir = filepath.Join(root, "hindsight-sync")
	}
	maxBytes, err := strconv.ParseInt(envOr("HINDSIGHT_SYNC_MAX_BYTES", strconv.Itoa(defaultMaxRelayBytes)), 10, 64)
	if err != nil {
		return errors.New("invalid HINDSIGHT_SYNC_MAX_BYTES")
	}
	s, err := newRelay(dir, os.Getenv("HINDSIGHT_SYNC_TOKEN"), maxBytes)
	if err != nil {
		return err
	}
	port, err := strconv.Atoi(envOr("HINDSIGHT_SYNC_PORT", "9078"))
	if err != nil || port < 1 || port > 65535 {
		return errors.New("HINDSIGHT_SYNC_PORT must be between 1 and 65535")
	}
	lock, err := lockState(dir)
	if err != nil {
		return fmt.Errorf("lock relay state: %w", err)
	}
	defer lock.Close()
	server := &http.Server{
		Addr:              net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
		Handler:           s.handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Minute,
		WriteTimeout:      15 * time.Minute,
		IdleTimeout:       30 * time.Second,
	}
	log.Printf("Hindsight sync relay listening on %s", server.Addr)
	return server.ListenAndServe()
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
