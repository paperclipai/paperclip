# Paperclip Known Gotchas

Operational knowledge base for Paperclip installation, onboarding, debugging, and future deployments.

This document records **operational discoveries**, not architecture. The architectural reference lives in `docs/qsl/implementation/EMAIL_COMPANY_LIVE_ARCHITECTURE_AND_PLAN_2026-07-19.md`. Anything that cost us time and would cost a future deployment time belongs here.

| Field | Value |
|---|---|
| Created | 2026-07-19 |
| Maintained by | QSL operations |
| Scope | QSL Paperclip deployments (Windows 11, PowerShell, Node 22, pnpm 9.15.4) |
| Rule | One entry per discovery: Symptom -> Cause -> Fix -> Prevention |

---

## Entry Format

```text
### N. Title
**Symptom:** what you observe.
**Cause:** why it happens.
**Fix:** what resolved it.
**Prevention:** how to avoid it next time.
```

---

## 1. OpenCode Provider Prefix Determines Authentication

**Symptom:** An agent configured with a DeepSeek model appears valid in the Paperclip UI but executes through a different provider than intended; OpenRouter billing/routing is not used.

**Cause:** OpenCode does not authenticate based on the model name alone. It authenticates according to the **provider prefix** in the model identifier.

```text
BAD:  deepseek/deepseek-chat
      -> Uses the direct DeepSeek provider and DeepSeek credentials.

GOOD: openrouter/deepseek/deepseek-chat
      -> Uses the OpenRouter provider and the configured OpenRouter API key.
```

Likewise, `openrouter/moonshotai/kimi-k3` and `openrouter/moonshotai/kimi-k2.5` authenticate through OpenRouter.

**Fix:** Re-select the model using its `openrouter/...` identifier in the agent's adapter config.

**Prevention:** Treat this as an operational requirement for all QSL Paperclip deployments: when the intent is OpenRouter billing and routing, always choose an `openrouter/...` model identifier rather than a provider-native identifier. Verify the exact identifier string with `opencode models` before creating the agent.

---

## 2. Windows PATH Repair (pnpm cannot spawn node)

**Symptom:** `pnpm install` succeeds but `pnpm dev` fails with `'node' is not recognized as an internal or external command`, `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`, and `Command "tsx" not found`. Diagnostics show the asymmetry: `node --version` works and `pnpm exec where node` finds node, but `pnpm exec node --version` fails with `spawn node ENOENT`.

**Cause:** Malformed **quoted entries in the System (Machine) PATH**:

```text
"C:\Program Files\Java"\bin
""C:\Program Files\Java"\bin
"          <- dangling quote as its own entry
```

Windows `CreateProcess` (used by Node's `child_process.spawn`) and `cmd.exe` fail to resolve anything in PATH after the quoted region. `C:\Program Files\nodejs\` appeared only after those entries, so spawned processes could not find node. PowerShell's own command resolution and `where.exe` tolerate the quotes, which is why interactive use looked healthy. Proven by stripping quotes in a process-local PATH copy: `spawn('node')` immediately succeeded.

**Fix:** Settings -> System -> About -> Advanced system settings -> Environment Variables -> **System variables -> Path** -> delete the three quoted entries (Java is already covered by `jdk-1.8\bin` and Oracle `javapath`). Open a **new** shell. Do **not** use `setx PATH` (truncation risk on long PATH values).

**Prevention:** After any Java/Maven/Helm installer touches PATH, inspect for quotes. Quick health check for any new Windows machine:

```text
node -e "require('child_process').spawn('node',['--version'],{stdio:'inherit'}).on('error',e=>console.log('ERR',e.message))"
```

If that prints a version, process spawning is healthy. Also note: `script-shell=Git Bash` and pnpm version were red herrings in this incident; neither was the cause.

---

## 3. Embedded Database Migration (stale embedded PostgreSQL)

**Symptom:** Server boot or migration preflight fails with missing-table / migration errors against the embedded database.

**Cause:** A stale embedded PostgreSQL data directory (from an older codebase or a different branch with a divergent migration journal) no longer matches the migrations the current code expects. Fork branches carrying custom migrations (e.g. `0182_qsl_findings`) and upstream (`0181` tip at audit time) share the same numbering space, so one data dir cannot serve both.

**Fix:** Do not repair in place. Point the server at a fresh instance (see Entry 4) and let embedded Postgres initialize and migrate cleanly on first boot.

**Prevention:** Instance-per-branch discipline. Give every branch/experiment its own instance via `PAPERCLIP_HOME` or `PAPERCLIP_INSTANCE_ID` (e.g. `email-clean-20260719`), or use `paperclipai worktree init` for automatic isolation under `~/.paperclip-worktrees/`. Never reuse a data directory across branches with divergent migration journals.

---

## 4. Clean Instance Creation Beats Database Repair

**Symptom:** Development database is corrupted, stale, or in an unknown state; time is being sunk into diagnosing it.

**Cause:** Embedded dev databases accumulate branch-specific migration state, half-applied experiments, and orphaned run locks. Repair requires understanding the full history; replacement requires none.

**Fix:** Create a fresh Paperclip instance. Observed in practice: creating the `email-clean-20260719` instance was faster and safer than repairing the corrupted development database, and produced a verified-clean baseline (`/api/health` -> `ok`, `bootstrapStatus: ready`). Legacy databases are preserved untouched per the canonical database policy; nothing is lost by starting clean.

**Prevention:** Treat dev instances as disposable, configs and doctrine as durable. Keep anything worth keeping (skills, agent definitions, company structure) in repo-tracked documents or company export bundles so a clean instance can be re-populated without the old database. After creating a fresh instance, expect the transient `database_backup_missing` health warning until the first hourly backup runs (or run `paperclipai db:backup` once).

---

## Running Log

| # | Date | Discovered during |
|---|---|---|
| 1 | 2026-07-19 | Email-company onboarding (agent model selection) |
| 2 | 2026-07-19 | Initial `pnpm dev` failure on Windows 11 |
| 3 | 2026-07-19 | Migration errors on stale embedded DB |
| 4 | 2026-07-19 | Recovery from corrupted dev database |
