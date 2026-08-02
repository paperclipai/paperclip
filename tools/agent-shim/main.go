package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

const (
	defaultRuntimeCommandPath = "/run/paperclip/runtime-command.json"
)

func main() {
	specPath := flag.String("spec", defaultRuntimeCommandPath, "path to AdapterRuntimeCommandSpec JSON")
	adapterType := flag.String("adapter", "", "adapter type (informational; e.g. claude_local)")
	flag.Parse()

	spec, err := loadRuntimeCommandSpec(*specPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[shim] cannot read runtime command spec: %v\n", err)
		os.Exit(2)
	}

	resolved, err := exec.LookPath(spec.Command)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[shim] adapter command %q not found in PATH (adapter=%s)\n", spec.Command, *adapterType)
		os.Exit(127)
	}

	// Build argv (resolved binary as argv[0])
	argv := append([]string{resolved}, spec.Args...)

	// syscall.Exec replaces this process; SIGTERM from k8s reaches the adapter directly.
	if err := syscall.Exec(resolved, argv, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "[shim] exec %q failed: %v\n", resolved, err)
		os.Exit(126)
	}
}
