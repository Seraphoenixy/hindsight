package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"math/big"
	"net/http"
	"testing"
	"time"

	"github.com/posterity/srp"
)

func TestPAKELogin(t *testing.T) {
	dir := t.TempDir()
	relay, err := newRelay(dir, testToken, defaultMaxRelayBytes)
	if err != nil {
		t.Fatal(err)
	}
	handler := relay.handler()
	salt := bytes.Repeat([]byte{42}, pakeSaltBytes)
	sha256ForTest := func(password string) []byte {
		sum := sha256.Sum256([]byte(password))
		return sum[:]
	}
	private := sha256ForTest("correct test password")
	verifier := new(big.Int).Exp(pakeParams.Group.Generator, new(big.Int).SetBytes(private), pakeParams.Group.N)
	record := pakeRecord{pakeVersion, salt, salt, verifier.FillBytes(make([]byte, pakeGroupBytes))}
	assertRequest := func(method, path, token string, body any, want int) []byte {
		t.Helper()
		res := apiJSON(t, handler, method, path, token, "", body)
		if res.Code != want {
			t.Fatalf("%s %s: got %d, want %d", method, path, res.Code, want)
		}
		return res.Body.Bytes()
	}
	const config = "/v3/auth/config"
	const initialize = "/v3/auth/initialize"
	const challenge = "/v3/auth/login/challenge"
	const verify = "/v3/auth/login/verify"
	assertRequest("POST", initialize, "", record, 401)
	assertRequest("POST", initialize, testToken, record, 204)
	assertRequest("POST", initialize, testToken, record, 409)
	if body := assertRequest("GET", config, "", nil, 200); bytes.Contains(body, []byte("verifier")) {
		t.Fatal("verifier is visible in public config")
	}
	assertRequest("POST", challenge, "", map[string][]byte{"client_public": make([]byte, pakeGroupBytes)}, 401)

	begin := func(password string) (*srp.Client, map[string]any) {
		t.Helper()
		params := pakeParams
		params.KDF = func(_, password string, _ []byte) ([]byte, error) {
			return sha256ForTest(password), nil
		}
		client, err := srp.NewClient(&params, pakeUsername, password, salt)
		if err != nil {
			t.Fatal(err)
		}
		public := new(big.Int).SetBytes(client.A()).FillBytes(make([]byte, pakeGroupBytes))
		wire := assertRequest("POST", challenge, "", map[string][]byte{"client_public": public}, 200)
		var response struct {
			ID     string `json:"challenge_id"`
			Public []byte `json:"server_public"`
		}
		if err := json.Unmarshal(wire, &response); err != nil {
			t.Fatal(err)
		}
		if err := client.SetB(response.Public); err != nil {
			t.Fatal(err)
		}
		proof, err := client.ComputeM1()
		if err != nil {
			t.Fatal(err)
		}
		proof = new(big.Int).SetBytes(proof).FillBytes(make([]byte, 32))
		return client, map[string]any{"challenge_id": response.ID, "client_proof": proof, "device_id": "dev-pake"}
	}

	_, bad := begin("wrong test password")
	assertRequest("POST", verify, "", bad, 401)
	assertRequest("POST", verify, "", bad, 401)
	_, expired := begin("correct test password")
	expiredID := expired["challenge_id"].(string)
	pending := relay.pake.challenges[expiredID]
	pending.expires = time.Now().Add(-time.Second)
	relay.pake.challenges[expiredID] = pending
	assertRequest("POST", verify, "", expired, 401)
	client, good := begin("correct test password")
	body := assertRequest("POST", verify, "", good, 200)
	var device struct {
		provisionedDevice
		ServerProof []byte `json:"server_proof"`
	}
	if err := json.Unmarshal(body, &device); err != nil {
		t.Fatal(err)
	}
	if valid, err := client.CheckM2(device.ServerProof); err != nil || !valid {
		t.Fatalf("invalid relay proof: %v", err)
	}
	assertRequest("POST", verify, "", good, 401)
	assertRequest("GET", v3StatusPath, device.Token, nil, 200)
	assertRequest("POST", initialize, device.Token, record, 403)

	relay, err = newRelay(dir, testToken, defaultMaxRelayBytes)
	if err != nil {
		t.Fatal(err)
	}
	handler = relay.handler()
	assertRequest("GET", v3StatusPath, device.Token, nil, 200)
	_, existing := begin("correct test password")
	assertRequest("POST", verify, "", existing, 409)
	_, existing = begin("correct test password")
	assertRequest("POST", verify, device.Token, existing, 200)
	assertRequest("POST", devicesActionPath+"dev-pake/revoke", testToken, nil, 200)
	_, revoked := begin("correct test password")
	assertRequest("POST", verify, device.Token, revoked, 403)
	assertRequest("GET", v3StatusPath, device.Token, nil, http.StatusForbidden)
}
