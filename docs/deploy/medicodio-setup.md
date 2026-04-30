# Medicodio Paperclip — Setup & Auth Migration

## What this doc covers

Two things we changed on the running system:

1. Made the repo **self-contained** (no machine-specific paths)
2. Switched from **no-auth local mode** to **authenticated mode** with real login

---

## Part 1 — Repo Portability

### The problem before

Paperclip stores config, secrets, and data files. By default it looks for them at `~/.paperclip/instances/default/` — a path hardcoded to one developer's home directory. This meant:

- Only worked on one machine
- Could not be cloned and run by another developer
- Some agent config files (`agents/hr/mcp.json`) had absolute paths like `/Users/karthikkhatavkar/...` baked in

### What we did

Created `.paperclip/` inside the repo root and put all config there.

```
medicodio-paperclip/
└── .paperclip/
    ├── config.json          ← committed — non-secret server config
    ├── .env                 ← gitignored — secrets (DB URL, keys)
    ├── .env.example         ← committed — template for new devs
    ├── secrets/
    │   └── master.key       ← gitignored — encryption key for secrets store
    ├── data/
    │   └── storage/         ← gitignored — uploaded files, company logos
    ├── logs/                ← gitignored — server logs
    └── instances/
        └── default/
            └── workspaces/  ← gitignored — per-agent working directories
```

**How Paperclip finds config:** On startup it walks up from the current working directory looking for a `.paperclip/config.json` file. It finds the repo-local one before ever reaching `~/.paperclip/`. No env var needed — it's automatic.

**CWD bug fix:** The pnpm dev command runs the server with CWD set to `server/`, not the repo root. Relative paths in config.json would resolve wrong. We fixed this in `scripts/dev-runner.ts` by injecting 4 absolute env vars:

```
PAPERCLIP_HOME               = /abs/path/to/.paperclip
PAPERCLIP_LOG_DIR            = /abs/path/to/.paperclip/logs
PAPERCLIP_STORAGE_LOCAL_DIR  = /abs/path/to/.paperclip/data/storage
PAPERCLIP_SECRETS_MASTER_KEY_FILE = /abs/path/to/.paperclip/secrets/master.key
```

These env vars override whatever paths are in config.json.

### Database

Config uses `mode: "postgres"` pointing to Azure PostgreSQL. No embedded/local postgres running. All developer machines and the production server share the same Azure DB.

```
host: medicodio-dev-db.postgres.database.azure.com
db:   paperclip
user: paperclip_user
```

### MCP agent config

Fixed `agents/hr/mcp.json` — was using absolute paths, now uses relative:

```json
// Before (broken on any machine except Karthik's laptop)
"args": ["/Users/karthikkhatavkar/medicodio-paperclip/packages/mcp-sharepoint/dist/stdio.js"]

// After (works anywhere)
"args": ["./packages/mcp-sharepoint/dist/stdio.js"]
```

### Result

Any developer clones the repo, copies `.env.example` → `.env`, fills in secrets, runs `pnpm dev` — it works. No machine-specific setup.

---

## Part 2 — Authentication Mode

### Two modes explained

| Mode | Login required | Who can access |
|---|---|---|
| `local_trusted` | No | Anyone who reaches the port |
| `authenticated` | Yes (email + password) | Only accounts you create |

`local_trusted` is fine for a single developer on localhost. It is **not safe** for any networked or hosted deployment — anyone who reaches port 3100 has full admin access with no credentials.

### What we changed

**Before:** `local_trusted` — no login, synthetic `local-board` user, Better Auth not running.

**After:** `authenticated` — login required, real user accounts in DB, Better Auth handling sessions.

### The migration sequence

1. Started server in `local_trusted` mode (Better Auth not active yet)
2. Added `PAPERCLIP_DEPLOYMENT_MODE=authenticated` to `.paperclip/.env`
3. Restarted server — Better Auth initialised, sign-up endpoint became active
4. Server detected it was migrating from `local_trusted` → generated a one-time **board-claim URL**
5. Created real account: `karthik.r@medicodio.ai` via `POST /api/auth/sign-up/email`
6. Opened board-claim URL in browser, signed in, clicked claim → account promoted to `instance_admin`
7. Set `disableSignUp: true` in `config.json` — no one can self-register now
8. Rotated `BETTER_AUTH_SECRET` to a strong 64-char hex value

### Database tables involved

Better Auth manages three tables automatically:

```
user     — who you are (id, name, email, emailVerified)
account  — credentials (email+password hashed with bcrypt, provider_id = "credential")
session  — active login sessions (JWT-backed, expire automatically)
```

One additional Paperclip table:

```
instance_user_roles — links user.id to role "instance_admin"
```

### Current user state

```
karthik.r@medicodio.ai — instance_admin — active
```

### BETTER_AUTH_SECRET

This secret signs all session tokens. Rules:

- Must be identical on every server that shares the same database
- If rotated, all existing sessions invalidate (everyone gets logged out)
- Store in `.paperclip/.env` (gitignored) — never commit it
- Copy the exact same value to the production server `.env` when hosting

---

## Part 3 — What's in `.paperclip/.env`

```bash
DATABASE_URL                  # Azure Postgres connection string
BETTER_AUTH_SECRET            # 64-char hex — signs session tokens
PAPERCLIP_AGENT_JWT_SECRET    # Signs agent heartbeat JWTs
SERVE_UI                      # false = Vite serves UI (dev), true = server serves UI (prod)
PAPERCLIP_DEPLOYMENT_MODE     # authenticated
SHAREPOINT_*                  # Azure AD app credentials for SharePoint MCP
OUTLOOK_*                     # Azure AD app credentials for Outlook MCP
APIFY_API_KEY                 # Apify web search key
```

---

## Part 4 — Production hosting checklist

When moving to a real server (Azure VM, App Service, etc.):

```bash
# Additional env vars needed for production
PAPERCLIP_DEPLOYMENT_EXPOSURE=public
PAPERCLIP_PUBLIC_URL=https://paperclip.medicodio.ai   # real domain
SERVE_UI=true                                          # server serves built UI
PAPERCLIP_HOME=/paperclip                             # absolute path on server

# Same secrets as dev (copy exactly)
BETTER_AUTH_SECRET=<same-value-as-dev>
PAPERCLIP_AGENT_JWT_SECRET=<same-value-as-dev>
DATABASE_URL=<same-azure-db>
```

Put nginx or Caddy in front for HTTPS termination. Paperclip itself speaks plain HTTP internally.

Update `config.json` on the server:
```json
"auth": {
  "baseUrlMode": "explicit",
  "publicBaseUrl": "https://paperclip.medicodio.ai",
  "disableSignUp": true
}
```

---

## Debugging reference

| Symptom | Check |
|---|---|
| Server starts but login page missing | `PAPERCLIP_DEPLOYMENT_MODE=authenticated` in `.env` |
| Login works but sessions drop | `BETTER_AUTH_SECRET` differs between restarts or machines |
| Logo missing / storage empty | `PAPERCLIP_STORAGE_LOCAL_DIR` env var pointing wrong dir |
| "Cannot decrypt" errors | `PAPERCLIP_SECRETS_MASTER_KEY_FILE` wrong path or missing file |
| Agent workspaces empty | `PAPERCLIP_HOME` wrong — workspaces live at `$PAPERCLIP_HOME/instances/default/workspaces/` |
| MCP server not found | `packages/mcp-sharepoint/dist/stdio.js` not built — run `pnpm build` |
| Someone can sign up | `disableSignUp: true` not set in `config.json` |
