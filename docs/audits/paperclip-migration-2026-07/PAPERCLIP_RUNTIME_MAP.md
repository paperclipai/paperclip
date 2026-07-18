# Paperclip Runtime Map

**Sprint:** 5A — Runtime Isolation and Canonical Instance Determination  
**Date:** 2026-07-16  
**Scope:** Read-only process, port, service, and deployment target survey  

---

## 1. Active Processes

### 1.1 Node.js Processes (all inspected via WMI)

| PID | Name | Path | Command Line / Purpose | Paperclip Relevance |
|-----|------|------|--------------------------|---------------------|
| 8764 | `node.exe` | `C:\Program Files\nodejs\node.exe` | `C:\Users\mikeb\AppData\Roaming\npm\node_modules\pm2\lib\Daemon.js` | PM2 daemon — **no managed processes** listed (`pm2 list` empty). Low relevance. |
| 35084 | `node.exe` | `C:\Program Files\nodejs\node.exe` | `npx -y @upstash/context7-mcp` | MCP server (Upstash Context7). **Not Paperclip.** |
| 36076 | `node.exe` | `C:\Program Files\nodejs\node.exe` | `npx @playwright/mcp@latest` | MCP server (Playwright). **Not Paperclip.** |
| 36724 | `node.exe` | `C:\Program Files\nodejs\node.exe` | `npx chrome-devtools-mcp@latest` | MCP server (Chrome DevTools). **Not Paperclip.** |
| 42792 | `node.exe` | `C:\Program Files\nodejs\node.exe` | `npx @playwright/mcp@latest` | Duplicate Playwright MCP instance. **Not Paperclip.** |
| 44436 | `node.exe` | `C:\Program Files\nodejs\node.exe` | `C:\Users\mikeb\AppData\Local\npm-cache\_npx\...\@playwright\mcp\cli.js` | Playwright MCP runtime. **Not Paperclip.** |
| 35212, 35520, 35556, 36512 | `node.exe` (Cursor helpers) | `C:\Users\mikeb\AppData\Local\Programs\cursor\...\node.exe` | Cursor IDE helper processes | **Not Paperclip.** |

**Conclusion:** No active Paperclip server, UI dev server, or adapter process is currently running.

### 1.2 PostgreSQL Process

| PID | Name | Data Directory | Port | State |
|-----|------|----------------|------|-------|
| 87504 | `postgres` (embedded) | `C:\Users\mikeb\.paperclip\instances\default\db` | **54329** | `ready` (per `postmaster.pid`) |

**Classification:** ACTIVE CONFLICT — database is alive but no consumer server is connected to it.

### 1.3 Docker

- **Docker Desktop daemon:** Running (`docker.exe` PID 44520)
- **Containers:** No `paperclip` or `postgres` containers running (`docker ps -a` clean)
- **Volumes:** No Paperclip-named volumes

### 1.4 PM2

- **PM2 daemon:** Running (PID 8764)
- **Managed processes:** **Zero** (`pm2 list` returns empty table)
- **No Paperclip services under PM2 management.**

### 1.5 Windows Services & Scheduled Tasks

- **Scheduled tasks:** No tasks matching `paperclip|node|postgres` found.
- **Windows services:** No Paperclip-specific services detected.

### 1.6 WSL

| Distro | State | Version |
|--------|-------|---------|
| Ubuntu | **Stopped** | 2 |
| docker-desktop | **Stopped** | 2 |
| Ubuntu-20.04 | **Stopped** | 2 |

**No Paperclip or postgres processes running inside WSL.**

---

## 2. Port Map

### 2.1 Ports with Active Listeners

| Port | Protocol | State | Owner / Purpose | Paperclip Relevance |
|------|----------|-------|-----------------|---------------------|
| 54329 | TCP | `LISTENING` | PostgreSQL embedded (`postmaster.pid` PID 87504) | **ACTIVE CONFLICT** — legacy database still bound |

### 2.2 Ports Previously Used by Paperclip (from `server.log` evidence)

| Port | Evidence | Last Observed | Status Today |
|------|----------|---------------|--------------|
| 3100 | `Server listening on 127.0.0.1:3100` (repeated in log) | 2026-06-22 10:43:44 | **FREE** — no listener |
| 3101 | `Server listening on 127.0.0.1:3101` (occasional) | 2026-06-22 22:07:00 | **FREE** — no listener |
| 5173 | Referenced in user-agent `referer: http://localhost:5173/QSL/...` | 2026-06-22 | **FREE** — Vite dev server not running |
| 5432 | Standard PostgreSQL default; `.env` points here | N/A | **FREE** — no listener |

**Conclusion:** Only port 54329 is occupied (by the stale embedded PostgreSQL). Ports 3100/3101 are clear for a new clean runtime.

---

## 3. Deployment Targets

### 3.1 Localhost

- **127.0.0.1:3100** — Historical Paperclip server port (last active 2026-06-22)
- **127.0.0.1:3101** — Fallback port used occasionally
- **127.0.0.1:5173** — Vite UI dev server port (used by frontend in dev mode)
- **127.0.0.1:54329** — Embedded PostgreSQL (active right now)

### 3.2 Remote / Cloud

| Target | Evidence | Status | Classification |
|--------|----------|--------|----------------|
| `147.93.42.105:65002` (Hostinger VPS) | `~/.ssh/config` entry `Host hostinger-therapistindex` | User `u624659440`; no active tunnel or process observed | **UNKNOWN — INVESTIGATE** if Paperclip was ever deployed here |
| `paperclip.quantumshieldlabs.dev` | Mentioned in operational context | **No local evidence** of active deployment or DNS config | **UNKNOWN — INVESTIGATE** |

### 3.3 EC2 / AWS

- No EC2 host entries found in `~/.ssh/config`
- No AWS CLI profiles or credentials examined (out of scope for read-only)

---

## 4. Server Lifecycle Evidence (from `server.log`)

| Event | Timestamp (log local time) | Detail |
|-------|---------------------------|--------|
| First run / DB creation | 2026-03-27 16:04:19 | Embedded PostgreSQL created; 45 migrations applied (0000–0044) |
| Multiple restarts | 2026-03-27 through 2026-06-22 | Server repeatedly restarted on 3100 (and occasionally 3101) |
| Last log entry | 2026-06-22 11:44:08 | Automatic database backup completed (56.2 MB) |
| Log file state | 2026-07-16 | **174 MB**, no shutdown message at EOF — suggests abrupt termination |

**Interpretation:** The Paperclip server ran continuously from late March through late June 2026, serving both QSL and Directory Factory companies. It stopped abruptly (no graceful shutdown log) and has not been restarted since 2026-06-22.

---

## 5. Runtime Classification

| Runtime Component | Classification | Reason |
|-------------------|----------------|--------|
| Paperclip server (Express API) | **INACTIVE / ISOLATED** | Not running. No process bound to 3100/3101. |
| Embedded PostgreSQL (port 54329) | **ACTIVE CONFLICT** | Still running. Schema stale. No matching `.env` config. |
| PM2 daemon | **INACTIVE / ISOLATED** | Running but managing zero processes. |
| MCP servers (Playwright, Context7, DevTools) | **INACTIVE / ISOLATED** | Unrelated background tooling. |
| Cursor IDE node helpers | **INACTIVE / ISOLATED** | IDE internals. |
| Vite dev server | **INACTIVE / ISOLATED** | Not running; no `data/pglite` directory exists. |
| Docker Desktop | **INACTIVE / ISOLATED** | No Paperclip containers. |
| WSL distros | **INACTIVE / ISOLATED** | All stopped. |

---

## 6. Unknowns

1. Whether the Hostinger VPS (`147.93.42.105:65002`) ever hosted a Paperclip deployment.
2. Whether `paperclip.quantumshieldlabs.dev` resolves to the Hostinger VPS or to another host.
3. Whether any cloud-hosted database (RDS, Supabase, etc.) is still pointed to by a stale environment file not discovered.
4. The exact reason for the abrupt server stop on 2026-06-22 (no crash dump examined).
