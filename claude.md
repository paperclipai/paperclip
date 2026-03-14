## Paperclip VPS credentials

- IP: `64.176.199.162`
- SSH: `root@64.176.199.162`
- Password: `bS%4nhouDq+gayS[`

## Notes

- Paperclip path: `/opt/paperclip`
- Docker Compose: `docker compose -f docker-compose.quickstart.yml`
- URL: http://64.176.199.162:3100
- Current deployed stack is running and healthy on `0.0.0.0:3100`
- Health check verified: `curl http://localhost:3100/api/health` returns `200 OK`

## Deployment progress

- The slow VPS rebuild issue was caused by rebuilding the UI on the VPS in the default `Dockerfile`
- Fast-build path is now available:
  - `Dockerfile.vps`
  - `docker-compose.vps.yml`
  - `docker-compose.vps-override.yml`
- Fast-build flow uses prebuilt `ui/dist` and skips the VPS UI build step
- The production image now includes `openssh-client`
- OpenCode is now deployed through the Paperclip-native runtime path instead of the earlier manual wrapper
- The running container now uses:
 - `PAPERCLIP_OPENCODE_COMMAND=/paperclip/bin/opencode`
 - `/paperclip/bin/opencode -> /opt/paperclip-opencode/node_modules/.bin/opencode`
 - `OPENCODE_CONFIG_CONTENT` with `ZAI_API_KEY` and `MINIMAX_API_KEY` sourced from deployment env
- Live model discovery is verified in the running container:
 - `zai/glm-5`
 - `minimax/MiniMax-M2.5`
- A rebuild initially failed during Docker image export because the VPS root disk was at `99%`
- Recovery was:
 - prune unused Docker data
 - rebuild `paperclip-server`
 - recreate `paperclip-server-1`
- Current rebuilt image size is about `952MB`
- Verified in the running container:
  - `ssh -V`
  - `ssh-add`
  - `ssh-keyscan`

## Runtime auth state

- Codex auth was copied from VPS host root auth into the runtime user's persisted home at `/paperclip/.codex`
- Verified as runtime user: `codex login status` reports logged in
- Claude Code is installed globally in the container and authenticated for the runtime user
- Verified as runtime user:
  - `claude --version`
  - `claude auth status`
- Claude auth is persisted under `/paperclip/.claude`

## CTO agent status

- CTO agent adapter type: `codex_local`
- Prior failing CTO run showed OpenAI `401 Unauthorized: Missing bearer or basic authentication in header`
- A fresh end-to-end CTO heartbeat was invoked after the fixes and succeeded
- Verified successful CTO run:
  - Agent id: `cfd857ce-4110-4f51-b996-17b8eb02bc7b`
  - Run id: `aeeda432-c3ba-41e6-b980-e8e8f5a1783c`
  - Final status: `succeeded`
- Current CTO agent status is `idle`

## Operational notes

- New SSH sessions from external tooling may time out during banner exchange when the VPS is under heavy load, even while an already-open interactive SSH session still works
- The container image does not include the `ps` utility; `docker exec ... ps` failing is not itself an app failure
- URL: http://64.176.199.162:3100

---

## How to add credentials / secrets to Paperclip agents

This section documents the exact process for adding new API credentials as encrypted secrets and wiring them to specific agents. Follow this every time — do not improvise.

### Architecture overview

- Secrets are stored encrypted (AES-256-GCM) in the `company_secrets` + `company_secret_versions` tables.
- The master key lives at `/paperclip/instances/default/secrets/master.key` inside the `paperclip-server-1` container on the VPS.
- Agent `adapter_config.env` references secrets via `{ "type": "secret_ref", "secretId": "<uuid>", "version": "latest" }`. The server decrypts and injects values at heartbeat runtime. Agents never see the raw keys in config.
- Non-sensitive env values (e.g. email addresses) can use `{ "type": "plain", "value": "..." }`.
- **The production API runs in `authenticated` mode** — direct REST calls require a board session. The only reliable path for scripted changes is the DB directly, using the encryption script below.

### Step 1 — Test the credentials before storing anything

Always verify credentials work before touching the database.

**Porkbun** uses two separate fields: `apikey` (starts `pk1_`) and `secretapikey` (starts `sk1_`). Ping endpoint requires both:
```bash
curl -s -X POST https://api.porkbun.com/api/json/v3/ping \
  -H "Content-Type: application/json" \
  -d '{"apikey":"pk1_...","secretapikey":"sk1_..."}'
# Expect: {"status":"SUCCESS","yourIp":"..."}
```

**Cloudflare** credentials come in two forms. The user's account uses a **Global API Key** (not a Bearer token), so auth uses email + key headers:
```bash
curl -s -X GET "https://api.cloudflare.com/client/v4/user" \
  -H "X-Auth-Email: nydamon@gmail.com" \
  -H "X-Auth-Key: <key>" \
  -H "Content-Type: application/json"
# Expect: {"success":true,"result":{"email":"nydamon@gmail.com",...}}
```
Do not use `Authorization: Bearer` for this account — that format is for API tokens, not Global API Keys.

Do not proceed to Step 2 until both tests return success.

### Step 2 — Identify the right agents

**Query the live DB for agents:**
```bash
ssh -i "/Users/damondecrescenzo/.ssh/paperclip-gha-deploy" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="/Users/damondecrescenzo/.ssh/known_hosts.paperclip-gha" \
  root@64.176.199.162 \
  'docker exec paperclip-db-1 psql -U paperclip paperclip \
    -c "SELECT id, name, role, adapter_type FROM agents WHERE company_id='"'"'<company_id>'"'"' ORDER BY name;"'
```

**Rule:** Only give credentials to agents whose job description requires them. Do not give infrastructure credentials to non-devops agents even if they're senior. Current mapping:

| Credential type | Agent(s) that should receive it |
|---|---|
| DNS / domain (Porkbun, Cloudflare) | Senior Platform Engineer (devops) |
| GitHub tokens | Senior Platform Engineer (devops) |
| Cloud provider keys (Vultr, AWS, etc.) | Senior Platform Engineer (devops) |
| LLM API keys | Agent-specific (whoever uses that model) |

If unsure, give access to the Senior Platform Engineer only and let them delegate via task assignment.

**Get current adapter_config to see existing env before modifying:**
```bash
docker exec paperclip-db-1 psql -U paperclip paperclip \
  -c "SELECT adapter_config FROM agents WHERE id='<agent_id>';"
```

### Step 3 — Get company ID

```bash
docker exec paperclip-db-1 psql -U paperclip paperclip \
  -c "SELECT id, name, issue_prefix FROM companies;"
```
Current company: `DLD Ent.` — `f6b6dbaa-8d6f-462a-bde7-3d277116b4fb` — prefix `DLD`

### Step 4 — Write and run the encryption + injection script

The script must run inside `paperclip-server-1` because that's the only container with access to the master key file. It uses only Node.js built-ins (no `pg` package — write SQL output to a file, then pipe it into psql).

**Template (`/tmp/gen-secrets.mjs`):**
```js
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const MASTER_KEY_PATH = "/paperclip/instances/default/secrets/master.key";
const COMPANY_ID = "<company_id>";
const AGENT_ID = "<agent_id>";

const secrets = [
  { name: "my-service-api-key", value: "actual_key_here", description: "What it is and why" },
  // add more...
];

function decodeMasterKey(raw) {
  const trimmed = raw.trim();
  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  try { const d = Buffer.from(trimmed, "base64"); if (d.length === 32) return d; } catch {}
  if (Buffer.byteLength(trimmed, "utf8") === 32) return Buffer.from(trimmed, "utf8");
  return null;
}

function encryptValue(masterKey, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { scheme: "local_encrypted_v1", iv: iv.toString("base64"), tag: tag.toString("base64"), ciphertext: ciphertext.toString("base64") };
}

function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }
function pgEsc(str) { return str.replace(/'/g, "''"); }

const masterKey = decodeMasterKey(readFileSync(MASTER_KEY_PATH, "utf8"));
if (!masterKey) throw new Error("Could not decode master key");

const sql = [];
for (const s of secrets) {
  const mat = pgEsc(JSON.stringify(encryptValue(masterKey, s.value)));
  const hash = sha256Hex(s.value);
  sql.push(`
DO $blk$
DECLARE sid uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM company_secrets WHERE company_id='${COMPANY_ID}' AND name='${s.name}') THEN
    INSERT INTO company_secrets (company_id, name, provider, description, latest_version)
      VALUES ('${COMPANY_ID}', '${s.name}', 'local_encrypted', '${pgEsc(s.description)}', 1)
      RETURNING id INTO sid;
    INSERT INTO company_secret_versions (secret_id, version, material, value_sha256)
      VALUES (sid, 1, '${mat}'::jsonb, '${hash}');
    RAISE NOTICE 'Created secret: ${s.name} -> %', sid;
  ELSE
    RAISE NOTICE 'Secret already exists: ${s.name}';
  END IF;
END $blk$;`);
}

// Patch agent env — add one jsonb_build_object entry per new key
sql.push(`
DO $blk$
DECLARE
  key_id uuid;
  cur_config jsonb;
  new_env jsonb;
BEGIN
  SELECT id INTO key_id FROM company_secrets WHERE company_id='${COMPANY_ID}' AND name='my-service-api-key';
  SELECT adapter_config INTO cur_config FROM agents WHERE id='${AGENT_ID}';
  new_env := COALESCE(cur_config->'env', '{}'::jsonb)
    || jsonb_build_object(
         'MY_SERVICE_API_KEY', jsonb_build_object('type','secret_ref','secretId',key_id,'version','latest')
       );
  UPDATE agents SET adapter_config = cur_config || jsonb_build_object('env', new_env), updated_at = now() WHERE id='${AGENT_ID}';
  RAISE NOTICE 'Patched agent env';
END $blk$;`);

console.log(sql.join("\n"));
```

**Run it:**
```bash
# 1. SCP script to VPS
scp -i "/Users/damondecrescenzo/.ssh/paperclip-gha-deploy" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="/Users/damondecrescenzo/.ssh/known_hosts.paperclip-gha" \
  /tmp/gen-secrets.mjs root@64.176.199.162:/tmp/gen-secrets.mjs

# 2. Copy into container, generate SQL, pipe to psql
ssh -i "/Users/damondecrescenzo/.ssh/paperclip-gha-deploy" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="/Users/damondecrescenzo/.ssh/known_hosts.paperclip-gha" \
  root@64.176.199.162 \
  'docker cp /tmp/gen-secrets.mjs paperclip-server-1:/tmp/gen-secrets.mjs && \
   docker exec paperclip-server-1 node /tmp/gen-secrets.mjs 2>&1 | \
   docker exec -i paperclip-db-1 psql -U paperclip paperclip 2>&1'
```

Expected output for each secret: `NOTICE: Created secret: <name> -> <uuid>`
Expected output for agent patch: `NOTICE: Patched agent env`

### Step 5 — Verify

```bash
# Check secrets were created
docker exec paperclip-db-1 psql -U paperclip paperclip \
  -c "SELECT name, provider, description, created_at FROM company_secrets WHERE company_id='<company_id>' ORDER BY created_at;"

# Check agent env has the new refs
docker exec paperclip-db-1 psql -U paperclip paperclip -t \
  -c "SELECT adapter_config FROM agents WHERE id='<agent_id>';" \
  | python3 -m json.tool | grep -A4 "MY_SERVICE"
```

### Step 6 — Clean up

Delete temp files from the VPS host and the container immediately after. They contain plaintext credentials:

```bash
ssh root@64.176.199.162 'rm -f /tmp/gen-secrets.mjs'
# Also remove the local temp file
rm -f /tmp/gen-secrets.mjs
```

### Common mistakes to avoid

| Mistake | Reality |
|---|---|
| Using `Authorization: Bearer` for Cloudflare | Only works for API Tokens. This account uses a Global API Key — use `X-Auth-Email` + `X-Auth-Key` headers. |
| Providing only one Porkbun field | Porkbun requires both `apikey` (`pk1_...`) AND `secretapikey` (`sk1_...`). They are different. |
| Importing `readFileSync` from `node:crypto` | `readFileSync` is in `node:fs`, not `node:crypto`. The script will fail silently if you mix them. |
| Running the script on the VPS host (not in container) | The master key is inside the `paperclip-server-1` container, not on the host. `docker exec` is required. |
| Using `pg` package inside the container script | `pg` is not in the container's global `node_modules`. Output SQL and pipe to psql instead. |
| Giving DNS credentials to all agents | Only the Senior Platform Engineer (devops role) needs DNS/infra credentials. |
| Calling `docker exec ... psql` with shell quoting containing `'` | Use `'"'"'` for embedded single quotes in SSH commands, or use psql's `-f` flag with a temp file. |

### Current secrets inventory

| Secret name | What it's for | Agent(s) with access |
|---|---|---|
| `vultr-api-key` | Vultr cloud API | Senior Platform Engineer |
| `github-token` | GitHub PAT (broad) | Senior Platform Engineer |
| `github-token-fine-grained` | GitHub fine-grained token | Senior Platform Engineer |
| `porkbun-api-key` | Porkbun domain API key (`pk1_...`) | Senior Platform Engineer |
| `porkbun-secret-api-key` | Porkbun secret key (`sk1_...`) | Senior Platform Engineer |
| `cloudflare-api-key` | Cloudflare Global API Key | Senior Platform Engineer |
| `github-token-viraforge` | GitHub PAT for `viraforge-ai` (ViraForge company account, `nydamon+paperclip@gmail.com`) | Senior Platform Engineer |
| `gws-service-account-key` | Google Workspace service account JSON key with domain-wide delegation (42 scopes, project `gam-project-2oeyh`) | Senior Platform Engineer |
| `gws-oauth2-refresh-token` | Google Workspace OAuth2 refresh token for `damon@prsecurelogistics.com` (backup / user-level access) | Senior Platform Engineer |
| `gws-client-secret` | Google Workspace GAM OAuth2 client secret (project `gam-project-2oeyh`) | Senior Platform Engineer |

`CLOUDFLARE_AUTH_EMAIL` is stored as a plain env value (`nydamon@gmail.com`) in the Senior Platform Engineer's adapter config, not as a secret (it is not sensitive).

`GWS_CLIENT_ID`, `GWS_ADMIN_EMAIL`, and `GWS_DOMAIN` are stored as plain env values in the Senior Platform Engineer's adapter config (not sensitive).

### Google Workspace notes

- **Domain**: `prsecurelogistics.com` — Customer ID `C020xhdcu`
- **Admin account**: `damon@prsecurelogistics.com`
- **GCP project**: `gam-project-2oeyh` (org: `605932361549`)
- **Service account**: `gam-project-2oeyh@gam-project-2oeyh.iam.gserviceaccount.com`
- **DWD client ID**: `105258313935190441372`
- **Auth method**: `GWS_SERVICE_ACCOUNT_JSON` is the primary credential. It contains a full service account key with domain-wide delegation across 42 scopes (Gmail, Drive, Calendar, Admin Directory, Groups, Reports, Chat, Meet, Docs, Sheets, etc.). This is non-expiring and does not require user interaction.
- **Fallback**: `GWS_OAUTH2_REFRESH_TOKEN` + `GWS_CLIENT_SECRET` + `GWS_CLIENT_ID` provide user-level OAuth2 access as `damon@prsecurelogistics.com`. Use this if service account DWD is insufficient for a specific API.
- **Org policy overrides**: `constraints/iam.disableServiceAccountKeyCreation` and `constraints/iam.disableServiceAccountKeyUpload` are overridden at project level (`enforce: false`) to allow the service account key to exist.
- **GAM**: Installed locally at `~/bin/gam7/gam`. Config at `~/.gam/`. Useful for ad-hoc Workspace admin commands from the dev machine.

### GitHub account notes

- `GITHUB_TOKEN` — classic PAT for `nydamon` (nydamon@gmail.com). Scopes: `repo, workflow`. `nydamon` is an **admin** of the `viraforge` org. Use for workflow triggers and as fallback.
- `GITHUB_TOKEN_FG` — fine-grained PAT for `nydamon`. Has **zero org memberships visible** (fine-grained PATs are resource-scoped). Do NOT use for `viraforge` org operations — it will 401/403.
- `GITHUB_TOKEN_VIRAFORGE` — classic PAT for `viraforge-ai` user (nydamon+paperclip@gmail.com). `viraforge-ai` is a **confirmed member of the `viraforge` org**. Use this for all ViraForge org repo creation, pushes, and code operations.

### GitHub token routing (which token to use for what)

| Operation | Token to use | Why |
|---|---|---|
| Create/push to repo in `viraforge` org | `GITHUB_TOKEN_VIRAFORGE` | viraforge-ai is org member, keeps commits under ViraForge identity |
| Create/push to personal `nydamon` repos | `GITHUB_TOKEN` or `GITHUB_TOKEN_FG` | both work |
| GitHub Actions workflow triggers | `GITHUB_TOKEN` | has `workflow` scope |
| Fallback if VIRAFORGE token fails | `GITHUB_TOKEN` | nydamon is org admin with `repo` scope |

### GitHub org: `viraforge`

- `nydamon` — org admin
- `viraforge-ai` — org member (added 2026-03-14)
- The correct org name is `viraforge` (not `viraforge-labs` — that org does not exist)
