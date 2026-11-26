package main

import (
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
)

var testToken = strings.Repeat("t", 32)

func TestPostgreSQLClients(t *testing.T) {
	python := os.Getenv("HINDSIGHT_SYNC_TEST_PYTHON")
	if python == "" {
		t.Skip("set HINDSIGHT_SYNC_TEST_PYTHON to run the client integration")
	}
	s, err := newRelay(t.TempDir(), testToken, defaultMaxRelayBytes)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(s.handler())
	defer server.Close()
	cmd := exec.CommandContext(t.Context(), python, "../scripts/linux-sync/test-sync.py", server.URL)
	cmd.Env = append(cmd.Environ(), "HINDSIGHT_SYNC_TOKEN="+testToken)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("PostgreSQL integration: %v\n%s", err, output)
	}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	t.Log(lines[len(lines)-1])
}
