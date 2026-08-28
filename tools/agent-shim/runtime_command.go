package main

import (
	"encoding/json"
	"errors"
	"os"
)

type RuntimeCommandSpec struct {
	Command        string   `json:"command"`
	Args           []string `json:"args"`
	DetectCommand  string   `json:"detectCommand,omitempty"`
	InstallCommand string   `json:"installCommand,omitempty"`
}

func loadRuntimeCommandSpec(path string) (*RuntimeCommandSpec, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var spec RuntimeCommandSpec
	if err := json.Unmarshal(b, &spec); err != nil {
		return nil, err
	}
	if spec.Command == "" {
		return nil, errors.New("runtime-command.json has empty 'command'")
	}
	return &spec, nil
}
