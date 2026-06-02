# Secret Handling Policy

**Policy source:** [FUL-2660](/FUL/issues/FUL-2660)  
**Hardening:** [FUL-3151](/FUL/issues/FUL-3151)  
**Permanent guardrails:** [FUL-3153](/FUL/issues/FUL-3153)

This document is the authoritative reference for secret handling rules (SH-*) that apply to all agents, scripts, and CI pipelines operating in the Help2day / Paperclip environment. Rules are summarised in `AGENTS.md`; the full pattern lists and safe alternatives live here.

---

## SH-4 — Rotate before closing

Secret rotation evidence must name the system updated, the timestamp, and the confirming run or ticket ID without including old or new credential values.

Secret version restore is only for reactivating retained previous versions. Deleting a Paperclip-managed secret is permanent: the provider material is deleted or archived according to provider semantics, database metadata is removed, and deleted secrets must not be treated as restorable through the version-restore endpoint.

---

## SH-10 — No credentials in process args (ps-exposure prevention)

**Source:** [FUL-4346](/FUL/issues/FUL-4346)  
**Guardrail script:** `scripts/check-sh10-argv-exposure.mjs` (runs on every PR)

### Why this matters

When a shell or subprocess is launched, the operating system writes each argument into the process argv. On Linux, `/proc/<pid>/cmdline` is world-readable by default, so any user on the host can read all arguments of any process via `ps aux` or `/proc`. A credential that appears as a CLI argument — including values expanded by shell variable substitution — is immediately visible to any co-tenant on the host.

**Root incident:** [FUL-6724](/FUL/issues/FUL-6724) — an API key was shell-expanded into a `curl -H` argument in an infra monitoring script.

**Prevention issue:** [FUL-6733](/FUL/issues/FUL-6733)

### Prohibited patterns

#### Shell scripts (`.sh`)

```bash
# PROHIBITED — shell expands $TOKEN into curl's argv
curl -H "Authorization: Bearer $TOKEN" "$URL"
curl --header "Authorization: Bearer $TOKEN" "$URL"
wget --header "Authorization: Bearer $TOKEN" "$URL"

# PROHIBITED — password visible in psql argv
psql "postgresql://user:$PGPASSWORD@host/db"
psql "postgresql://user:${PGPASSWORD}@host/db"

# PROHIBITED — any connection URI with password variable
mysql -u user "mysql://user:$DB_PASS@host/db"
redis-cli -u "redis://:$REDIS_PASS@host:6379"
mongosh "mongodb://user:$MONGO_PASS@host/db"
```

#### Node.js / JS / TS scripts

```js
// PROHIBITED — template literal expands ${TOKEN} into a shell command string
execSync(`curl -H "Authorization: Bearer ${TOKEN}" ${url}`);
exec(`curl -H "Authorization: Bearer ${TOKEN}" ${url}`, callback);
spawn("sh", ["-c", `curl -H "Authorization: Bearer ${TOKEN}" ${url}`]);

// PROHIBITED — template literal expands ${PASS} into connection URI argv
execSync(`psql "postgresql://user:${PGPASSWORD}@${host}/db"`);
spawnSync("psql", [`postgresql://user:${DB_PASS}@host/db`]);

// PROHIBITED — string concatenation in exec call
execSync('curl -H "Authorization: Bearer ' + TOKEN + '" ' + url);
```

### Safe alternatives

#### Shell scripts — curl config via process substitution

```bash
# SAFE — token never appears in curl's argv
curl -sS -X POST \
  --config <(printf 'header = "Authorization: Bearer %s"\n' "$PAPERCLIP_API_KEY") \
  -H 'Content-Type: application/json' \
  --data-binary "$payload" \
  "$URL"
```

The `<(...)` process substitution creates a file descriptor that curl reads internally. The token value is never part of the argv visible to `ps`.

#### Shell scripts — temp config file (when process substitution is unavailable)

```bash
# SAFE — config file has 600 permissions, not in argv
_auth_cfg="$(mktemp)"
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$_auth_cfg"
chmod 600 "$_auth_cfg"
curl -sS --config "$_auth_cfg" ...
rm -f "$_auth_cfg"
```

#### Shell scripts — PostgreSQL safe patterns (SH-11)

```bash
# SAFE — password via env var (not argv)
PGPASSWORD="$DB_PASSWORD" psql -U user -h host -d db

# SAFE — .pgpass file (chmod 600)
# Write host:port:db:user:password to ~/.pgpass and chmod 600
```

#### Node.js / JS / TS — args array (no shell expansion)

```js
// SAFE — args array bypasses shell; credential goes into subprocess env, not argv
const result = spawnSync("curl", [
  "-sS", "-X", "POST",
  "-H", `Authorization: Bearer ${TOKEN}`,  // argv IS visible this way too — see note below
  url,
]);
```

> **Note:** Even with `spawnSync(..., args_array)`, each element of the args array still becomes a separate argv entry readable via `ps aux`. The only fully safe approach for CLI tools is to pass credentials via a config file or stdin, not via args.

```js
// SAFE — write a temp config, pass path as arg
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "curl-cfg-"));
const cfgPath = join(dir, "auth.cfg");
writeFileSync(cfgPath, `header = "Authorization: Bearer ${TOKEN}"\n`, { mode: 0o600 });
try {
  spawnSync("curl", ["--config", cfgPath, url], { stdio: "inherit" });
} finally {
  unlinkSync(cfgPath);
}
```

```js
// SAFE — pass credential via environment variable, not argv
// (works for tools that support env-var auth, e.g., PGPASSWORD for psql)
spawnSync("psql", ["-U", "user", "-h", "host", dbName], {
  env: { ...process.env, PGPASSWORD: password },
  stdio: "inherit",
});
```

### Opt-in escape hatch

If a line is legitimate and cannot be changed (e.g., it is a doc-comment or test fixture showing an example of the prohibited pattern), suppress the check with:

```bash
# sh10:allow-argv-credential: example in usage docs, not executed
curl -H "Authorization: Bearer $TOKEN" "$URL"
```

```js
// sh10:allow-argv-credential: test fixture — not a real invocation
const fixture = `curl -H "Authorization: Bearer ${TOKEN}"`;
```

The marker may appear on the violating line or the line immediately above it.

### Guardrail coverage

The `scripts/check-sh10-argv-exposure.mjs` script runs on every PR (see `.github/workflows/pr.yml` `policy` job). It scans:

- `scripts/` — official utility and infra scripts
- `skills/` — agent skill scripts
- `packages/adapters/` and `packages/adapter-utils/` — adapter source
- `server/src/` — server source
- `cli/src/` — CLI source

Shell scripts (`.sh`) are checked for direct `$VAR` interpolation patterns. JS/TS files are checked for template literal `${VAR}` interpolation inside `execSync`/`exec`/`spawn`/`spawnSync` call contexts.

---

## SH-15 — Service-inspection argv-observation denylist

**Source:** [FUL-6737](/FUL/issues/FUL-6737)  
**Related:** SH-10 (creation prohibition — don't embed credentials in argv); this rule covers the **observation vector** — commands that *display* process argv that may already contain credentials.  
**Denylist entry name:** `service-status-argv-observation`

### Why this matters

`systemctl status <service>` prints the service's `ExecStart=` command line with all shell variables already expanded, along with the live process tree and its command-line arguments. Any credential that was shell-interpolated into a process argument (an SH-10 violation, past or present) is immediately visible to anyone who can run the command. This is true even if SH-10 guardrails now prevent *new* such scripts — legacy or third-party processes may still have credentials in their argv.

**Root incident:** [FUL-6736](/FUL/issues/FUL-6736) — `systemctl status paperclip.service --no-pager` printed live process argv containing secret-bearing command lines during a rotation investigation.

**Prevention issue:** [FUL-6737](/FUL/issues/FUL-6737)

### Banned Commands

| Command | Why it is prohibited |
|---|---|
| `systemctl status <service>` | Prints `ExecStart=` with expanded args and live process argv in the cgroup tree |
| `systemctl show <service>` *(without `--property` filter)* | Dumps all unit properties including `ExecStart=` command line |
| `systemctl cat <service>` | Prints raw unit file including `ExecStart=` template lines |
| `ps aux`, `ps -ef`, `ps -ewo` | Already in SH-10 — process list with full argv; explicitly denylist-named here |
| `cat /proc/<pid>/cmdline`, `strings /proc/<pid>/cmdline` | Already in SH-10; named here for completeness |
| `journalctl -u <service> -n 1 --no-pager` *(when output includes startup ExecStart log lines)* | May echo the full command line from the service startup journal entry |

### Safe alternatives

```bash
# SAFE — boolean active/inactive/failed; no argv output
systemctl is-active paperclip.service

# SAFE — boolean enabled/disabled
systemctl is-enabled paperclip.service

# SAFE — scoped property read without ExecStart
systemctl show paperclip.service --property=ActiveState,SubState,LoadState

# SAFE — application-level health check (preferred in agent contexts)
curl -fsS http://127.0.0.1:3100/api/health
```

> **Agent context rule:** In agent scripts and heartbeats, prefer application-level API health checks (`/api/health`, `/api/agents/me`) over `systemctl` invocations entirely. The systemd service manager is for human operators, not automated agents.

### Opt-in escape hatch

To suppress the check for a legitimate diagnostic line (e.g., in runbooks written for human operators):

```bash
# sh15:allow-service-inspect: human-operator runbook step, not automated
systemctl status paperclip.service
```

---

## SH-11 — Safe PostgreSQL connection patterns

**Source:** [FUL-4346](/FUL/issues/FUL-4346)

Never embed a DB password in a connection URI passed as a CLI argument. Safe patterns:

```bash
PGPASSWORD="$DB_PASSWORD" psql -U user -h host -d db
```

Application code must source DB credentials from harness-injected env vars only.

---

## SH-12 — Never use `gh auth` credential-reporting commands

**Source:** [FUL-5491](/FUL/issues/FUL-5491)

Prohibited: `gh auth status`, `gh auth token`, `gh auth login --show-token`.

Safe: boolean exit-code check with output suppressed — `gh auth status >/dev/null 2>&1`.

---

## SH-13 — Never read disk-based credential store files

**Source:** [FUL-6464](/FUL/issues/FUL-6464)

Never read `~/.config/gh/hosts.yml`, `~/.netrc`, `~/.ssh/id_*`, `~/.aws/credentials`, `~/.docker/config.json`, `~/.npmrc`, `~/.kube/config`, or `~/.pypirc`. Use harness-injected env vars instead.

---

*Full SH-* rule text lives in `AGENTS.md` (Security Engineer section). This file contains the extended pattern lists and safe-alternative code samples.*
