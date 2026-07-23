---
title: Claude Code
summary: Claude Code local adapter setup and configuration
---

The `claude_local` adapter runs Anthropic's Claude Code CLI locally. It supports session persistence, skills injection, and structured output parsing.

## Prerequisites

- Claude Code CLI installed (`claude` command available)
- Either `ANTHROPIC_API_KEY` in adapter env/host env, or a Claude Code
  subscription login available to the execution target

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | Yes | Working directory for the agent process (absolute path; created automatically if missing when permissions allow) |
| `model` | string | No | Claude model to use (e.g. `claude-opus-4-6`) |
| `promptTemplate` | string | No | Prompt used for all runs |
| `env` | object | No | Environment variables (supports secret refs) |
| `timeoutSec` | number | No | Process timeout (0 = no timeout) |
| `graceSec` | number | No | Grace period before force-kill |
| `maxTurnsPerRun` | number | No | Max agentic turns per heartbeat (defaults to `300`) |
| `dangerouslySkipPermissions` | boolean | No | Skip permission prompts (default: `true`); required for headless runs where interactive approval is impossible |
| `bedrockCredentialRefreshCommand` | string | No | Shell command run to self-heal an expired AWS/Bedrock token before deferring (e.g. `ada credentials update --account … --provider … --role … --once`, `aws sso login`). Runs via `sh -c` with the adapter's resolved env/cwd. Only used under Bedrock auth. See [Self-healing AWS/Bedrock credentials](#self-healing-awsbedrock-credentials-mas-751). |
| `bedrockCredentialRefreshTimeoutSec` | number | No | Timeout for the refresh command (default `60`). Bounded so a wedged refresh can never hang a heartbeat. |
| `bedrockPreflightTimeoutSec` | number | No | Timeout for the pre-flight `sts get-caller-identity` probe (default `5`). |
| `bedrockPreflightBackoffSec` | number | No | How long to defer the run when credentials are expired and could not be refreshed (default `180`). |

## Prompt Templates

Templates support `{{variable}}` substitution:

| Variable | Value |
|----------|-------|
| `{{agentId}}` | Agent's ID |
| `{{companyId}}` | Company ID |
| `{{runId}}` | Current run ID |
| `{{agent.name}}` | Agent's name |
| `{{company.name}}` | Company name |

## Session Persistence

The adapter persists Claude Code session IDs between heartbeats. On the next wake, it resumes the existing conversation so the agent retains full context.

Session resume is cwd-aware: if the agent's working directory changed since the last run, a fresh session starts instead.

If resume fails with an unknown session error, the adapter automatically retries with a fresh session.

### Poisoned `previous_message_id` (recovery)

Symptom in logs / issue thread:

```
API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)
```

What it means: the on-disk Claude Code transcript JSONL for that session contains a malformed (non-`msg_`-prefixed) `previous_message_id`. Anthropic's `/v1/messages` rejects every resume attempt against that transcript with a deterministic 400. Without guards, Paperclip would re-persist the same poisoned session id and the issue is stranded permanently — see [RED-976](../../../) / [RED-978](../../../).

What the adapter does automatically:

1. **Auto-rotate on resume.** If a `--resume` attempt returns this 400, the adapter retries once with a fresh session, deletes the poisoned `<session>.jsonl` from the local Claude config dir (best effort), and uses the fresh session id going forward.
2. **Validate-before-persist.** A result that carries this 400 never gets its `session_id` written back to the task session store, even if Claude Code emits one in the result event. The adapter returns `sessionId: null`, `sessionParams: null`, and `errorCode: "claude_poisoned_previous_message_id"`.
3. **Clear-on-error.** The adapter sets `clearSession: true` on the result, which causes the heartbeat service to drop any persisted session row for that issue (`clearTaskSessions`). The next continuation starts from a clean slate.

On-call checklist if you see this in production:

- Confirm `errorCode` is `claude_poisoned_previous_message_id` in the run row — that means the guards fired correctly and the issue auto-recovers on the next heartbeat.
- If the same issue still loops after one heartbeat, check that `agentTaskSessions` for that `(agentId, taskKey)` was cleared. If not, the adapter return value was lost (e.g. a malformed run finalization) — escalate; do **not** manually edit the row, file a child issue with the run id.
- For remote execution targets (sandbox/SSH), the poisoned JSONL is on the remote and the adapter only logs the cleanup intent. The fresh-session retry still succeeds because it uses a new session id, and the server-side `clearSession: true` is authoritative regardless of remote disk state.

## Self-healing AWS/Bedrock credentials (MAS-751)

Under Bedrock auth (`CLAUDE_CODE_USE_BEDROCK=1` or `ANTHROPIC_BEDROCK_BASE_URL` set), an expired AWS security token makes the Claude CLI spawn do zero work and exit `403 The security token included in the request is expired`. Historically the in-flight process died with no further output, which tripped Paperclip's silent-run watchdog (`stale_active_run_evaluation`) and generated false-positive "Review silent active run" issues — the run wasn't hung, its creds had lapsed.

The adapter handles this in three layers, so a credential lapse never surfaces as a silent hang:

1. **Refresh-before-invoke (pre-flight).** Before spawning the CLI, a bounded `aws sts get-caller-identity` probe checks token validity. On a *positive* expiry detection, if `bedrockCredentialRefreshCommand` is configured the adapter runs it (`sh -c`) and re-probes; if the re-probe clears (or is indeterminate), the run proceeds normally. The probe fails open — a timeout, missing `aws` CLI, `AccessDenied`, or any non-expiry outcome proceeds to spawn and never hangs the heartbeat.
2. **Auto-refresh on mid-run 403.** A token can lapse *between* the pre-flight probe and the inference call (or slip past the fail-open probe). When the spawn fails with an expired-token `403`, the adapter runs the refresh command and retries the invoke exactly once. Bounded to one retry so a persistently-expired token can never loop.
3. **Graceful defer fallback.** If no refresh command is configured, or refresh does not recover the token, the run does **not** die silently. The adapter returns a `transient_upstream` result (`errorCode: claude_transient_upstream`) with a `retryNotBefore` set `bedrockPreflightBackoffSec` seconds out, so the recovery rails snooze and re-arm the run instead of the watchdog cutting a false-positive silent-run issue. Deferred pre-flight runs emit exactly one greppable `BEDROCK_CREDENTIAL_EXPIRED` marker per lapse; refresh attempts emit `BEDROCK_CREDENTIAL_REFRESH` markers.

**Operator note:** the refresh command is intentionally operator-supplied (same trust level as `command`/`env`) because credential provisioning is environment-specific — `ada credentials update`, `aws sso login`, `mwinit`, a `credential_process` wrapper, etc. Leave it unset to keep the safe detect-and-defer behavior with no in-place refresh.

## Skills Injection

The adapter creates a temporary directory with symlinks to Paperclip skills and passes it via `--add-dir`. This makes skills discoverable without polluting the agent's working directory.

## Remote credential ownership

`claude_local` uses a snapshot-owns-auth topology for managed sandbox execution
targets. When the run uses a sandbox execution target and no explicit
`CLAUDE_CONFIG_DIR` is configured, Paperclip creates a remote
`CLAUDE_CONFIG_DIR` under the run's Claude runtime directory. It uploads
sanitized host-side settings such as `settings.json` and `CLAUDE.md`, but the
managed seed does not upload host Claude credential files.

After the seed is copied, the remote materialization command checks the
execution target's own `$HOME/.claude` directory. For each missing credential
file, it copies `.credentials.json` or `credentials.json` from that remote home
into the managed `CLAUDE_CONFIG_DIR`. That means credentials baked into the
sandbox image win for managed remote Claude runs.

Worked example: a sandbox image contains `$HOME/.claude/.credentials.json` from
its own Claude Code login. Paperclip starts a managed remote `claude_local` run,
uploads only the sanitized config seed, and sets `CLAUDE_CONFIG_DIR` to the
remote runtime config path. Because the managed config has no credential file,
the adapter copies the sandbox image's `$HOME/.claude/.credentials.json` into
that path before invoking Claude. The sandbox snapshot owns the credential for
the run.

This differs from [`codex_local`](/adapters/codex-local), where a
Paperclip-managed sandbox run uploads a host-owned `CODEX_HOME/auth.json` and
therefore shadows any Codex login already present inside the sandbox image.

For manual local CLI usage outside heartbeat runs (for example running as `claudecoder` directly), use:

```sh
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

This installs Paperclip skills in `~/.claude/skills`, creates an agent API key, and prints shell exports to run as that agent.

## Environment Test

Use the "Test Environment" button in the UI to validate the adapter config. It checks:

- Claude CLI is installed and accessible
- Working directory is absolute and available (auto-created if missing and permitted)
- API key/auth mode hints (`ANTHROPIC_API_KEY` vs subscription login)
- A live hello probe (`claude --print - --output-format stream-json --verbose` with prompt `Respond with hello.`) to verify CLI readiness
