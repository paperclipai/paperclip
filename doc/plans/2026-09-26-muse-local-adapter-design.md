# `muse_local` adapter: Muse Code subscription support

Status: Phases 1–3 implemented 2026-09-26. Live-smoked on a Muse Code subscription: local runs, AI connection (terminal sign-in + API key), and SSH runs on chaos-srv (the agent used the Paperclip API through the bridge). Sandbox (Daytona) device login is unit-tested only (no Daytona account).

## Goal

Run Paperclip agents on Meta's Muse Code CLI, billed to the operator's Muse
Code subscription, with the same level of support Paperclip gives Codex and
Claude subscriptions: a local adapter that runs the CLI, and an in-app device
login that stores a per-company credential.

Success means:

- An operator picks "Muse Code" as an agent's adapter, clicks "Log in", approves
  a code on `auth.meta.com`, and the agent's next heartbeat runs on Muse.
- Two companies logged in to two different Meta accounts never share a
  credential.
- A host that already ran `muse login` works without the in-app login.
- A Paperclip server on macOS never reads or overwrites the operator's own
  Muse keychain entry.

## Verified CLI facts (Muse Code 1.4.0-R4161.1, probed 2026-09-26)

- `muse` is a bash launcher (`~/.local/bin/muse`) that execs
  `muse-bin-<version>` next to it. `MUSE_LAUNCHER_INSTALL=1 muse` installs the
  binary without logging in; `MUSE_NO_AUTO_UPDATE=1` stops background updates.
  Install: `curl -fsSL https://api.meta.ai/muse-launcher.sh`.
- `muse login` is an OAuth device flow against `auth.meta.com`. Run headless
  (stdin `/dev/null`, stdout not a TTY), it prints on stdout:

  ```
  Open this page to sign in:
    https://auth.meta.com/oauth/device/?code=SVTC-XZCS
  confirm this code matches:
    SVTC-XZCS

  Waiting for approval…
  Logged in. Credential saved to <XDG_CONFIG_HOME>/muse/auth.json.
  Model API access verified.
  ```

- Credential storage defaults to the OS keychain on every platform. On headless
  Linux it fails after a successful approval:
  `login succeeded but saving failed: … keychain write failed (internal error -2147483648)`.
  `TBH_CREDENTIAL_BACKEND=file` makes the CLI write `auth.json` (mode 0600)
  instead. Other values (`plaintext`, `insecure-file`, `keychain`) fall back to the keychain.
- A file-backend login writes:
  `{schema_version: 1, providers: {meta: {mechanism: "oauth", obtained_via: "device_code", api_base_url, api_key, access_token, user_email, user_full_name}}}`.
  `api_key` is 48 characters with the prefix `LLM|`. There is no expiry and no
  refresh token.
- `META_API_KEY` takes priority over any stored login. `muse exec` with only
  `META_API_KEY` set and an empty `XDG_CONFIG_HOME` / `XDG_DATA_HOME` succeeds.
- The CLI honours `XDG_CONFIG_HOME` (credentials, settings, trust) and
  `XDG_DATA_HOME` (sessions, session index, skills, plugins).
- `muse exec --json` writes MSP records as JSONL on stdout: every line has
  `schema_version`, `id`, `stream: {kind: "session", id}`, `sequence`,
  `recorded_at`, `record_type` (`event`, `status`, `reconciliation`). Human
  chatter goes to stderr. `muse schema` exports the full wire schema.
  `--no-session-log` disables the session store, so resume needs logs on.

## Architecture

### 1. Adapter package `packages/adapters/muse-local`

Modelled on `grok-local` (smallest adapter with device login) and
`kimi-local` (CLI execution). Exports follow the other local adapters:
`type = "muse_local"`, `label = "Muse Code"`, `models`,
`agentConfigurationDoc`, `SANDBOX_INSTALL_COMMAND`, and `server` / `ui` /
`cli` entry points.

- **Models:** `muse-spark-1.3` (default) and `muse-spark-1.3-contributor`.
  `reasoningEffort` config: `none|minimal|low|medium|high|xhigh|max|ultra`,
  default `high`.
- **`execute`:** writes the rendered prompt to a temp file and runs
  `muse exec --json --model <m> --reasoning-effort <e> --workspace <cwd>
  --approval-mode never --session-id <uuid> --prompt-file <file> [extraArgs]`
  with the environment from section 3. It streams stdout through `parse.ts`
  into Paperclip transcript entries, usage, and the final answer. Exit code
  and a missing final answer map to run errors, the same way `kimi-local`
  does.
- **Sessions:** the session codec stores `{sessionId, cwd}`. A heartbeat
  reuses `sessionId` when the stored cwd matches the current cwd; otherwise
  it passes a fresh `randomUUID()` (Muse creates the session under that id). Muse's session
  store lives in the per-agent `XDG_DATA_HOME`, so resume survives across heartbeats.
- **`parse.ts`:** a pure JSONL parser over MSP records, built from
  `muse schema` output and the recorded fixture
  `src/server/__fixtures__/exec-basic.jsonl` (recorded copy: `doc/plans/2026-09-26-muse-exec-basic.jsonl`). Unknown `record_type` values are
  ignored, not fatal.
- **Skills:** Paperclip skills are copied into `<cwd>/.agents/skills/` for the
  run (see "Run-time behaviour").
- **`testEnvironment`:** reports the CLI path and version, and whether a
  credential source exists (`META_API_KEY` or a host login) with a
  `muse exec` hello probe.
  It never prints the key.
- **UI:** a config form (model, reasoning effort, cwd, command, extraArgs,
  env, timeouts) and the login affordance flag, following `grok-local/src/ui`.

### 2–4. Credentials, login and wiring (revised 2026-09-26, rev 2)

Rev 1 said to put the key in a company secret named `MUSE_API_KEY`. Mapping the codebase showed
that Paperclip already has a credential system for subscriptions, **AI
connections** (`packages/shared/src/ai-connections.ts`), with providers
`anthropic`, `openai`, `openrouter`, `xai`. Grok subscriptions are an `xai`
AI connection whose secret is staged into each run. Muse joins that
system as provider **`meta`** instead of inventing a parallel store. The work
splits into three phases, each shippable on its own:

**Phase 1: the `muse_local` adapter.** The package (execute, JSONL parser,
skills, environment test, session codec, UI and CLI parsers, config
form) plus every adapter registration point (shared adapter types, server,
UI and CLI registries, conversation and git-sensitive sets, packaging,
telemetry enum). Credentials in phase 1: `META_API_KEY` from the agent's env
bindings (an existing Paperclip secret binding), else the host's own `muse
login`. Useful end to end on a machine where `muse login` has been run.

**Phase 2: AI connection provider `meta`.** Add `meta` to `AI_PROVIDERS` and
`AI_CONNECTION_CAPABILITIES` with `subscription` and `api_key` methods, both
for adapter `muse_local` with `envKey: "META_API_KEY"`. The stored secret is
the bare `LLM|…` key for both methods. Runs inject it as `META_API_KEY`,
so meta is **not** a `subscriptionFile` provider and needs no auth-file merge
or rotation (the key has no expiry and no refresh token). Local terminal sign-in
(`local-ai-login.ts`) prints
`(export XDG_CONFIG_HOME=<home>/xdg XDG_DATA_HOME=<home>/xdg-data TBH_CREDENTIAL_BACKEND=file MUSE_NO_AUTO_UPDATE=1 && mkdir -p "$XDG_CONFIG_HOME" && muse login)`.
The verifier reads `<home>/xdg/muse/auth.json`, extracts `providers.meta.api_key`,
and live-checks it with `GET https://api.meta.ai/v1/models`. It also needs a
DB migration that widens the two provider CHECK constraints
(`ai_provider_defaults`, `ai_connection_defaults`), the UI provider lists and
logo, and `agents.ts` provider and inheritable-key maps.

**Phase 3: sandbox device login.** Add a closed login-command key `muse` in
all three lockstep unions (`server/src/services/login-command.ts`,
`packages/plugins/sandbox-providers/daytona/src/login-pty.ts`,
`packages/plugins/sdk/src/protocol.ts`), a `muse_local` entry in
`DISPLAYED_CODE_ADAPTER_TYPES` / `DISPLAYED_CODE_PROFILES`, a registry
`loginCapability` (displayed_code), and a promotion in `agents.ts`. The
sandbox credential reader only reads `<sessionHome>/auth.json` with
`O_NOFOLLOW`, so the Daytona launch line for `muse` is fixed per key:
`exec env XDG_CONFIG_HOME=<home>/xdg XDG_DATA_HOME=<home>/xdg-data TBH_CREDENTIAL_BACKEND=file MUSE_NO_AUTO_UPDATE=1 sh -c 'muse login && install -m 0600 "$XDG_CONFIG_HOME/muse/auth.json" <home>/auth.json'`.
The reader stays unchanged. Promotion validates the Muse auth shape,
then saves the bare key to the AI connection (managed sessions) or to the
company home `<instance>/companies/<id>/muse-home/api-key` (0600) for
unmanaged sessions, which `execute` reads into `META_API_KEY`. The runner image
(`docker/daytona-runner/Dockerfile`) installs Muse with the launcher
(`MUSE_LAUNCHER_INSTALL=1`). `muse_local` also joins `REMOTE_MANAGED_ADAPTERS`.

**Prompt parser (phase 3):** `parseMuseDeviceLoginPrompt` is a pure function
with the same rules as the Grok parser. It strips ANSI CSI and accepts only origin
`https://auth.meta.com`, path `/oauth/device/`, exactly one query key `code`, and no
fragment. The code must match `^[A-Z0-9]{4}-[A-Z0-9]{4}$` and equal the code on
its own line after `confirm this code matches:`.

### Run-time behaviour (all phases)

- argv: `exec --json --model <m> --reasoning-effort <e> --approval-mode never
  --trust-workspace --workspace <cwd> --prompt-file <tmp> [--session-id <id>]
  [extraArgs]`. `--trust-workspace` is required: without it Muse loads no
  project skills or rules.
- Instructions file: its contents are prepended to the prompt (as in kimi and gemini).
  Skills: copied into `<cwd>/.agents/skills/<name>` for the run and removed
  afterwards. Muse discovers `.agents/skills` and `.claude/skills` in trusted
  workspaces (verified).
- Env: `XDG_DATA_HOME` = `<instance>/companies/<companyId>/muse-data/<agentId>`
  (session store, so resume survives heartbeats),
  and `MUSE_NO_AUTO_UPDATE=1`. Runs must NOT set `TBH_CREDENTIAL_BACKEND=file`
  (verified: it hides a macOS keychain `muse login` and the run fails with
  "missing meta credentials"). That variable is for login only. `XDG_CONFIG_HOME` is left alone, so a host `muse login`
  still works when no `META_API_KEY` is provided.
- JSONL (fixtures `doc/plans/2026-09-26-muse-exec-{basic,tool,badkey}.jsonl`):
  the session id is `stream.id`, and the model is `payload.model_id` on
  `run.model.configured`. Assistant deltas are `payload.text` on `run.output.delta`.
  Tool output is `payload.call_id` / `payload.text` on `tool.result`. The
  final answer and status are `payload.text`, `payload.terminal`
  (`completed|failed|cancelled`) and `payload.reason` on `run.terminal.completed`.
  Failed tasks are `task.lifecycle.*` with `payload.event.kind = "failed"` and
  `payload.event.reason`. **Muse emits no token usage in JSONL**, so usage
  is reported as zero.
- Auth failure: `terminal: "failed"` with a reason matching
  `/API key .* was rejected|No Meta credentials|saved Meta credentials are invalid/`
  sets `errorCode: "muse_auth_required"` and a "log in to Muse again" message.
  There is no retry.
- Sessions (verified): `--session-id <uuid>` resumes that session when it exists in
  `XDG_DATA_HOME` and otherwise creates a new session with that id. So `execute`
  always passes `--session-id`: the stored id when cwd matches, else
  `randomUUID()`. No unknown-session retry path is needed.
- Billing: `provider: "meta"`, `biller: "muse"`, `billingType: "subscription"`,
  `costUsd: null`.

## Security

- Muse keys are stored only as Paperclip secrets or AI connection secrets (or the
  0600 company-home file in phase 3). They never go into
  config JSON, logs, transcripts, thrown errors, or run results. (`server/src/middleware/redact-sensitive.ts` redacts by key name, not value pattern, for every provider, so no `LLM|` value pattern is added; keys are kept out of logs and results by construction and by test.)
- The parser rejects any URL that isn't `https://auth.meta.com/oauth/device/`,
  so a tampered CLI cannot send the operator to a phishing page.
- The scratch login home is deleted after promotion whether it succeeds or not.

## Testing

- `device-login-parse.test.ts`: captured plain and ANSI-coloured prompts;
  negatives for wrong origin, wrong path, extra query key, fragment,
  mismatched code, and bad code shape.
- `adapter-auth-promotion.test.ts`: accepts a valid file credential; rejects
  keychain-storage stubs, a missing `api_key`, an API-key-only (`auth set`)
  credential, and an oversized file; checks that the scratch home is deleted.
- `parse.test.ts`: the recorded `exec-basic.jsonl` fixture plus a tool-call
  fixture recorded during implementation.
- `execute.test.ts`: a fake `muse` script checks the argv, the env precedence
  (secret beats host login, XDG dirs), session resume, and `muse_auth_required`
  mapping.
- Live smoke test: one heartbeat on the operator's subscription through the
  in-app login.

## Out of scope

- Quota and usage display (Codex/Claude `quota.ts`): add it once Muse has a
  usage endpoint that is known to work with the subscription key.
- The ACP/MSP persistent engine (`muse serve`): the CLI engine only for v1.
- Remote/sandbox execution beyond what `adapter-utils` gives local adapters
  for free.
