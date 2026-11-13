package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadRuntimeCommandSpec_OK(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "spec.json")
	_ = os.WriteFile(p, []byte(`{"command":"claude-code","args":["--print"]}`), 0o600)
	spec, err := loadRuntimeCommandSpec(p)
	if err != nil {
		t.Fatalf("expected ok, got %v", err)
	}
	if spec.Command != "claude-code" || len(spec.Args) != 1 {
		t.Fatalf("unexpected spec: %+v", spec)
	}
}

func TestLoadRuntimeCommandSpec_MissingCommand(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "spec.json")
	_ = os.WriteFile(p, []byte(`{"command":""}`), 0o600)
	if _, err := loadRuntimeCommandSpec(p); err == nil {
		t.Fatal("expected error for empty command")
	}
}
