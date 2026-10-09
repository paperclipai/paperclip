# Hermes native runner (pending qualification)

Hermes runs as a per-turn native ACP process through ACPX 0.13.1. The bridge
adapts questions, active steering, tool policy, accounting and strict recovery;
Hermes retains its own agent loop, native tools and memory. There is no Hermes
gateway daemon, native cron scheduler, or SQLite polling transcript adapter.
The standalone `hermes_local` and `hermes_gateway` adapters retain their contracts.

## Distribution

The source-owned declaration is `src/providers/hermes/version.json`: release
`v2026.9.24`, commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`, Python
3.12.14, ACP SDK 0.9.0 and ACPX 0.13.1. Provisioning verifies the source archive
and upstream `uv.lock`, then installs the locked ACP, MCP, Anthropic, Bedrock and
Google extras. Use uv 0.12.17. No installation occurs during an agent turn.

```sh
# From the repository root, with an absolute, nonexistent destination:
node packages/paperclip-runner/scripts/provision-hermes.mjs \
  "$PWD/packages/paperclip-runner/provider-assets/hermes/darwin-arm64"
# Linux amd64 uses the linux-x64 destination instead.
```

The materializer emits a complete closure digest. Compare it with the reviewed
platform pin in `hermes-installation.ts`; never adopt an unexpected digest at
runtime. Runtime launch verifies the installed bytes and host sandbox before
credential staging, then opens a private verified snapshot for execution.
Python uses `-I -B` and the bundled interpreter.
The npm package carries the bridge and provisioner; Python is a separately
provisioned asset, included by `--candidate-providers=hermes` in provider packs.

macOS command tools require `sandbox-exec`. Linux command tools require
`bubblewrap` and permission to create its process/mount namespaces. Installing
bubblewrap alone does not grant that permission. A default Docker container
was observed to reject namespace creation; setup fails before credentials are
staged there. Actual Daytona namespace behavior remains a qualification
requirement. Building a provider pack verifies its bytes without probing the
builder's sandbox; the execution host performs that probe at admission.

## Connections and identity

Use the existing account/model picker and the `hermes_runner` managed projection.
API keys map to the matching native provider. Codex and Grok subscriptions are
projected into Hermes auth.json and translated back through existing freshness,
ownership and revocation checks. Claude subscriptions use the existing managed
OAuth-token path. Custom Chat Completions, Responses and Messages routes retain
their protocol, endpoint and authentication choice. Bedrock retains its managed
region and bearer credential. These are implemented projections, not evidence
that each provider/method has passed live qualification.

Native execution input v7 carries a value-free connection fingerprint and
optional authorized attachments. Existing v1–v5 inputs and Dot v6 remain
replayable. The reader also accepts recorded Hermes v6 qualification inputs
when their provider is explicitly ACPX Hermes, normalizing them to v7. The
fingerprint covers the selected account epoch and routing configuration; token
refresh does not replace a compatible session. Model, account, endpoint and
permission changes use the existing replacement rules.

Credentials use the ephemeral runtime path and process-lifetime fence. Native
auth, refresh handoff, configuration, environment files and diagnostic logs are
excluded from recovery copies. Only `hermes/memories` and `hermes/skills` enter
managed agent-file storage. Session databases stay private to a normalized
conversation. Assigned Paperclip skills remain separate protected inputs.

Between turns, authenticated run attachment refreshes the registered agent-file
working copy and assigned tool bindings. The session still pins prompt, bundle,
skill, connection, model, and permission identities. Unknown policy changes and
changes within the same run are rejected.

## Interaction contract

- Reasoning and assistant text use distinct message identities. Native tool
  call IDs preserve overlapping calls and edit snapshots.
- Native questions publish a 65,536-character limit for text and custom
  answers. The form, canonical response validation and bridge count UTF-16
  code units consistently, so an accepted answer can resume the native callback.
- Images accept PNG, JPEG, WebP and GIF; documents accept UTF-8 text/Markdown.
  Limits are eight attachments, 2 MiB per item and 4 MiB total. The combined
  message and attachments also have a 7 MiB JSON-encoded limit, including
  escaping and metadata, to fit the encrypted Runner command frame. The controller
  authorizes and reads content before the turn; URLs and arbitrary local paths
  are rejected. Models without image support can reject image input.
- The negotiated `_meta.paperclipHermes.version = 1` extension uses ACP wire
  methods `_hermes/turn_started`, `_hermes/ask_questions`, `_hermes/steer`,
  `_hermes/usage` and `_hermes/delegation`. Python's ACP SDK adds the leading
  underscore. Questions and controls bind to the active session and turn token.
- Steering requires an explicit native acknowledgement. Follow-ups remain in
  the durable Paperclip queue. Stop cancels native work and pending input before
  bounded provider-process cleanup.
- Restored history is recorded without becoming new assistant text or live tools.
- Restoration requires nonempty native history and follows the native
  compaction chain. Missing history and failed persistence are errors.
- Usage is a per-prompt delta. Native price calculations are labeled estimates;
  missing receipts and unverified billed cost are unavailable, not zero.

The managed execution middleware applies planning/read-only, protected-path and
permission policy to inline, concurrent and delegated native tools. Assigned
MCP tools use the authenticated runner bridge; startup fails if that catalog
cannot be loaded. Ambient configured MCP discovery and unmanaged plugin/config
loading are disabled.

## Proactive work

Paperclip owns scheduling. Native `cronjob`, gateway messaging and native task
mutations are disabled in this profile. The live `manage_routine` semantic tool
creates, updates, pauses and resumes self-assigned routines through the existing
routine service. Updates require the current revision and retries require an
idempotency key. Listing/inspection use existing authorized read APIs.

Scheduled firings create ordinary Paperclip work with routine provenance and
retain existing ownership, budget, pause, concurrency and duplicate-fire rules.

Provisioning requires uv 0.12.17 and, on macOS, Command Line Tools for
`install_name_tool` plus `codesign`. The Python closure normalizes interpreter
installation paths so local consumers and image builds reproduce the same pin.
Credential cleanup runs after verified exit even when learned-state collection
fails; save failures remain visible through normal runtime errors.

## Qualification

Hermes stays visibly **pending**. Candidate execution is an operator diagnostic
opt-in, never enabled by agent-supplied session JSON. The server's existing
`PAPERCLIP_RUNNER_ACPX_QUALIFICATION` allowlist accepts an exact Hermes/model
entry. The runner CLI accepts `--candidate-profile hermes`.

```sh
pnpm --filter @paperclipai/paperclip-runner build:typescript
pnpm --filter @paperclipai/paperclip-runner test:hermes:transport
```

The browser campaign definitions and implementation record are supplied by
[qualification PR #15436](https://github.com/paperclipai/paperclip/pull/15436).
Apply that companion PR before running its commands:

```sh
pnpm test:e2e:runner -- --list --suite extended-harnesses
pnpm test:e2e:runner -- --id extended-harnesses.runner-acpx-hermes.local.hello-complete
```

The opt-in transport tests execute the pinned native process against a
deterministic HTTP model fixture. It is not paid-model, browser or Daytona
qualification. One test exercises the ACPX host directly; the other includes
TypeScript, Rust PRP, the packaged sidecar, image delivery and semantic task
completion. The companion Product E2E catalog contains five local and five Daytona
Hermes cells using a managed OpenRouter connection. Each connection method,
native control, attachment, persistence, remote restoration and permission mode
must pass its release criterion with inspectable live evidence before promotion.
The implementation record is included in that qualification PR.
