package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
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

func TestStreamWithFraming_PassThrough(t *testing.T) {
	in := strings.NewReader("a\nb\nc\n")
	var out bytes.Buffer
	if err := streamWithFraming(in, &out); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); got != "a\nb\nc\n" {
		t.Fatalf("unexpected: %q", got)
	}
}
