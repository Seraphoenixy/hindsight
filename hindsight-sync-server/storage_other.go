//go:build !linux

package main

import (
	"errors"
	"os"
)

func lockState(string) (*os.File, error) {
	return nil, errors.New("the standalone relay runs on Linux")
}

// Non-Linux hosts can exercise the protocol via the HTTP handler tests.
func syncDirectory(string) error { return nil }
