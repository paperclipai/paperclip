# Security & Best Practice Critique: `paperclip-control.sh`

## Verdict

The script is **well-designed** for a single-operator dev/staging context. The `op run` + `strip_dotenv_keys` pattern is genuinely good — secrets are ephemeral, never written to disk by the script, and shell injection is actively defended against. The layered compose approach keeps upstream files clean.

---

## 🔴 Service Account Token Trust Model

`.envrc` contains a **raw 1Password service account token** — the credential that unlocks the `openclaw` vault. The token cannot itself be stored behind 1Password (it _is_ the bootstrap credential).

| Control | Status |
|---|---|
| `.envrc` in `.gitignore` | ✅ Ignored |
| `.envrc` tracked by git | ✅ Not tracked |
| `.envrc` file permissions | ✅ `0600` |
| Token rotation | ✅ 3-month expiry |
| Token scope | ✅ Scoped to `openclaw` vault only |

> [!NOTE]
> **Optional hardening**: The token could be stored in the macOS Keychain instead of a file:
> ```bash
> OP_SERVICE_ACCOUNT_TOKEN="$(security find-generic-password -s paperclip-op-token -w)"
> ```
> This keeps the token out of the filesystem entirely. **Caveat**: `security find-generic-password` requires the login keychain to be unlocked, which happens automatically when the user is logged in. For truly headless scenarios (launchd at boot before login, SSH without keychain forwarding), the keychain would be locked and this would fail. The current `.envrc` file approach is more portable for non-interactive use.

---

## 🟡 Remaining Finding

### `source .envrc` executes arbitrary code

`source .envrc` (in `paperclip-control.sh`) runs whatever is in that file. If `.envrc` is compromised (supply-chain, shared filesystem, etc.), it executes with full user privileges. This is the same trust model as direnv itself, so it's not a regression — but worth noting that the script inherits direnv's trust boundary.

---

## 🟢 Things Done Well

| Practice | Implementation |
|---|---|
| **Secrets never on disk** | `op run` resolves `op://` URIs in-process; the script never writes resolved values |
| **Shell injection defence** | `strip_dotenv_keys` neutralises inherited env before both code paths |
| **Dual-mode strip** | `unset` for real runs, `stub` for compose-validation-only commands — minimal secret exposure |
| **Compose `:?` isolation** | `BETTER_AUTH_SECRET:?` handled per-path — dummy for stop, pre-flight check for start |
| **No hardcoded var names** | Strip/stub loop driven from `.env` keys, not a hardcoded list |
| **Authoritative `.envrc` source** | Always sourced — overrides any inherited token from a different 1Password account |
| **`.env`/`.envrc` gitignored** | Neither is tracked; both are in `.gitignore` |
| **File permissions** | Both `.env` and `.envrc` set to `0600` |
| **Token scoping** | Service account scoped to `openclaw` vault only, 3-month expiry |
| **`set -euo pipefail`** | Fail-fast on errors, undefined vars, and pipe failures |
| **Verbose mode** | Debug output gated behind `-v` — no secret leakage in normal operation |
| **Value redaction** | Sensitive-looking keys show `prefix••••suffix` in verbose output for disambiguation without exposure |
| **Stray op:// detection** | `with_secrets` warns about inherited `op://` refs not declared in `.env` that may break `op run` |

---

## 💭 Why Do We Have to Write This?

The root cause is a gap in the Docker Compose + 1Password ecosystem:

1. **Docker Compose has no native secret provider integration.** It only knows `${VAR}` interpolation and `env_file`. There's no `secrets_provider: 1password` in the compose spec.

2. **`op run` is designed for simple `command` wrapping**, not for multi-file compose with layered overrides, conditional commands (stop vs start), and mixed secret/non-secret paths.

3. **direnv solves interactive shells only.** Scripts, crons, and CI need a different mechanism.

The script exists at the intersection of these three tools' limitations. Docker Compose assumes secrets are already in the environment. 1Password assumes you're wrapping a single command. Direnv assumes you're a human in a terminal. Nobody owns the glue.

> [!NOTE]
> **Alternatives that would eliminate this script:**
> - **Docker secrets + Swarm mode** — compose `secrets:` with external providers, but requires Swarm
> - **1Password Connect Server** — a local API that containers query directly for secrets, bypassing `op run` entirely
> - **Infisical / Doppler / Vault Agent** — dedicated secret injection sidecars that mount secrets as files or env vars inside the container
>
> All of these move secret resolution **inside** the container runtime rather than wrapping it from the outside. That's the architecturally correct boundary — but each adds deployment complexity that may not be justified for a single-operator dev setup.
