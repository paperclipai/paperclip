# hermes-paperclip-adapter

Production-oriented Paperclip adapter for [Hermes Agent](https://github.com/NousResearch/hermes-agent).

This package is designed to be a **peer** of Paperclip's mature local adapters rather than a thin proof-of-concept bridge. It implements:

- execution with structured resume handling and retry on stale sessions
- model/provider detection from Hermes config
- dynamic model listing from `~/.hermes/config.yaml`
- environment diagnostics that check API keys, Hermes home, Claude Code auth hints, and custom endpoints
- Paperclip-aware wake prompts for tasks, comments, approvals, and autonomous hiring
- bundled Paperclip skills that are synced into `~/.hermes/skills/...`
- structured stdout parsing for Paperclip transcript rendering
- declarative config schema for UI-driven configuration
- durable `onHireApproved()` notifications
- test-first architecture with focused unit tests around parsing, model detection, prompt rendering, skills sync, and execution planning

## Package layout

```text
src/
  shared/          Shared constants and pure helpers
  server/          Server adapter runtime, diagnostics, skills, config schema
  ui/              UI config builder and stdout transcript parser
  cli/             Placeholder CLI surface for parity with Paperclip package layout
skills/
  paperclip/       Bundled Hermes skills for Paperclip control-plane usage
tests/
  *.test.js        Node built-in test runner coverage
docs/
  ARCHITECTURE.md
  PAPERCLIP_INTEGRATION.md
  TROUBLESHOOTING.md
  TESTING.md
```

## What this adapter expects from Hermes

Hermes capabilities used by the adapter are grounded in the public Hermes Agent CLI and config surface:

- `hermes chat -q ...`
- optional `-Q/--quiet`
- `--model`, `--provider`, `--toolsets`, `--resume`, `--source`, `--max-turns`, `--checkpoints`, `-w`, `-v`
- config/env loaded from `~/.hermes/config.yaml` and `~/.hermes/.env`
- session persistence via Hermes session IDs
- skill directories under `~/.hermes/skills/`

## Install

```bash
npm install hermes-paperclip-adapter
```

## Local development

```bash
npm test
```

## Typical Paperclip registration

If Paperclip loads the adapter as an external package, point it at the server adapter factory or use the named exports directly, depending on your plugin loader.

Minimal expectations from the host:

- call `listModels()` if exposed
- call `getConfigSchema()` if exposed
- persist `sessionParams` and send them back on the next run
- pass `ctx.authToken` for agent-authenticated Paperclip API calls
- pass wake context in `ctx.context` rather than hiding it in raw adapter config

## Important host-side Paperclip patches

To get full parity, Paperclip core should also do the following:

1. expose `hermes_local` consistently in shared adapter type constants
2. wire Hermes `listModels` in the server registry
3. wire Hermes `sessionManagement` in the server registry
4. wake the requesting agent on approval rejection and revision-request events, not only approval success

See `docs/PAPERCLIP_INTEGRATION.md` for exact details.
