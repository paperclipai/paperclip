# Proposed `cmd/launch/paperclip.go` for ollama/ollama

This is the reference implementation we're proposing upstream so
`ollama launch paperclip` is a first-class integration alongside `codex`,
`opencode`, `droid`, etc. Modeled directly on
[`cmd/launch/codex.go`](https://github.com/ollama/ollama/blob/main/cmd/launch/codex.go).

## File: `cmd/launch/paperclip.go`

```go
package launch

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/ollama/ollama/envconfig"
)

// Paperclip implements Runner for the Paperclip integration
// (https://github.com/paperclipai/paperclip).
type Paperclip struct{}

func (p *Paperclip) String() string { return "Paperclip" }

func (p *Paperclip) args(model string, extra []string) []string {
	args := []string{"onboard", "--bind", "loopback", "-y", "--run"}
	return append(args, extra...)
}

func (p *Paperclip) Run(model string, args []string) error {
	if err := checkPaperclipInstalled(); err != nil {
		return err
	}

	cmd := exec.Command("paperclipai", p.args(model, args)...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	// Pre-wire Paperclip's ollama_local adapter for the user. The adapter
	// reads OLLAMA_HOST and OLLAMA_API_KEY directly.
	env := append(os.Environ(),
		"OLLAMA_HOST="+envconfig.Host().String(),
		"PAPERCLIP_DEFAULT_ADAPTER=ollama_local",
	)
	if model != "" {
		env = append(env, "PAPERCLIP_DEFAULT_MODEL="+model)
	}
	cmd.Env = env
	return cmd.Run()
}

func checkPaperclipInstalled() error {
	if _, err := exec.LookPath("paperclipai"); err != nil {
		return fmt.Errorf("paperclip is not installed, install with: npm install -g paperclipai")
	}
	return nil
}
```

## Registry entry — patch for `cmd/launch/registry.go`

Add to `integrationSpecs`:

```go
{
	Name:        "paperclip",
	Aliases:     []string{"paperclipai"},
	Runner:      &Paperclip{},
	Description: "Paperclip — control plane for AI-agent companies",
	Install: IntegrationInstallSpec{
		CheckInstalled: func() bool {
			_, err := exec.LookPath("paperclipai")
			return err == nil
		},
		URL:             "https://github.com/paperclipai/paperclip",
		InstallCommands: []string{"npm install -g paperclipai"},
	},
},
```

## Smoke test (`cmd/launch/paperclip_test.go`)

```go
package launch

import "testing"

func TestPaperclipString(t *testing.T) {
	p := &Paperclip{}
	if got := p.String(); got != "Paperclip" {
		t.Fatalf("String() = %q, want %q", got, "Paperclip")
	}
}

func TestPaperclipArgs(t *testing.T) {
	p := &Paperclip{}
	args := p.args("", []string{"--extra"})
	want := []string{"onboard", "--bind", "loopback", "-y", "--run", "--extra"}
	if len(args) != len(want) {
		t.Fatalf("args len = %d, want %d", len(args), len(want))
	}
	for i, a := range args {
		if a != want[i] {
			t.Fatalf("args[%d] = %q, want %q", i, a, want[i])
		}
	}
}
```

## Notes for review

- `paperclipai` CLI is published to npm by the Paperclip team. The `--bind
  loopback -y --run` quickstart starts the server on a trusted local interface
  and accepts defaults — the equivalent of how the Codex profile gets
  pre-written before launch.
- `OLLAMA_HOST` / `OLLAMA_API_KEY` are read by Paperclip's `ollama_local`
  adapter directly (see
  [`packages/adapters/ollama-local/src/server/models.ts`](https://github.com/paperclipai/paperclip/blob/main/packages/adapters/ollama-local/src/server/models.ts))
  so Cloud and local modes both work without further config.
- `PAPERCLIP_DEFAULT_ADAPTER` and `PAPERCLIP_DEFAULT_MODEL` are accepted as
  hints by the onboard wizard. (If the maintainers prefer they be read at the
  agent-creation step instead, that's a one-line change on Paperclip's side.)

If maintainers prefer the integration `Edit`s a config file the way `Droid`
does (writing `~/.paperclip/...`), we're happy to switch to that pattern in
review.
