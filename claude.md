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
- **CI: merge vs deploy vs npm (three separate actions):** (1) Merge PR → `verify` + `policy` on the PR. (2) Ship the app → run **`deploy-vultr.yml`** when ready (`gh workflow run deploy-vultr.yml --repo Viraforge/paperclip --ref master`). (3) Publish npm canary/stable → run **`release.yml`** with workflow_dispatch (`channel` `canary` or `stable`); **not** triggered by merge. Canary also runs on a **nightly schedule** (02:00 UTC). Requires **`NPM_TOKEN`** in GitHub Environments `npm-canary` and `npm-stable`.
- **GHCR-based deploy (2026-03-18):** Docker image is now built on GitHub Actions and pushed to `ghcr.io/viraforge/paperclip:<sha>`. VPS only pulls and recreates. `Deploy Vultr` is now `workflow_dispatch` only — no longer triggers on push to master.
  - Image path: `ghcr.io/viraforge/paperclip:<github_sha>`
  - VPS reads image tag from `PAPERCLIP_SERVER_IMAGE` env var during compose commands
  - Current image pointer on VPS: `/opt/paperclip/current-image`
  - Rollback: `PAPERCLIP_SERVER_IMAGE=$(cat /opt/paperclip/current-image-prev) docker compose ... up -d --force-recreate --no-deps server`
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

## Agent devtools in production image

Both `Dockerfile` and `Dockerfile.vps` now install the following in the production image for agent efficiency:
- `gh` — GitHub CLI, with the default `gh` entrypoints (`/usr/bin/gh` and `/paperclip/bin/gh`) wrapped to use an ephemeral `GH_CONFIG_DIR` so standard `gh` usage does not persist auth state in the shared `/paperclip` volume
- `ripgrep` — fast file search (`rg`); agents prefer this over `grep` fallback
- `fd-find` — fast file finder (`fd`, symlinked from `fdfind`)
- `procps` — provides `ps`, `top`, etc.
- `tree` — directory tree display
- `patch` — apply patch files

Operational rule for `gh` inside the production container:
- Never run `gh auth login`
- Token exclusivity is enforced by agent env binding: only the Senior Platform Engineer receives a GitHub token
- Expose the selected SPE-only GitHub secret as `GITHUB_TOKEN` or `GH_TOKEN` at runtime, even if the source secret is named differently (for example `GITHUB_TOKEN_VIRAFORGE`)
- The default `gh` entrypoints set a fresh temp `GH_CONFIG_DIR` for each invocation, reducing reusable auth state leakage during normal `gh` usage across Docker updates
- The relocated raw binary path is internal implementation detail and should not be invoked directly

## npm tool version pinning

All four agent CLI tools are pinned via Docker `ARG` in both `Dockerfile` and `Dockerfile.vps`:

| ARG | Current value |
|-----|---------------|
| `CLAUDE_CODE_VERSION` | `2.1.78` |
| `GEMINI_CLI_VERSION` | `0.34.0` |
| `CODEX_VERSION` | `0.115.0` |
| `OPENCODE_VERSION` | `1.2.27` |

These can be overridden at build time with `--build-arg`. The values were last updated 2026-03-18 to unblock the deploy pipeline after `@openai/codex@0.1.2504221644` (a non-existent beta version) caused `npm error notarget` failures since March 16.

## Docker build: plugin-sdk must be compiled before server

The server imports `@paperclipai/plugin-sdk` (workspace package at `packages/plugins/sdk/`). TypeScript's NodeNext module resolution requires `dist/` to exist before `tsc` runs on the server. Both Dockerfiles now do:

```
RUN pnpm --filter @paperclipai/plugin-sdk build && pnpm --filter @paperclipai/server build
```

The main `Dockerfile` also has `COPY packages/plugins/sdk/package.json packages/plugins/sdk/` in the `deps` stage. Omitting either step causes `TS2307: Cannot find module '@paperclipai/plugin-sdk'` and cascading TypeScript errors throughout the plugin system files.

## GitHub plugin (paperclip-github)

- Plugin ID: `0ec9cc46-eca5-48b0-aee9-61c4bdfceb9f`
- Package path in container: `/app/packages/plugins/github-integration`
- Status: `ready` (installed 2026-03-18)
- Webhook endpoint: `http://64.176.199.162:3100/api/plugins/0ec9cc46-eca5-48b0-aee9-61c4bdfceb9f/webhooks/github-events`
- Configured for repo: `Viraforge/paperclip`
- Default assignee: Senior Platform Engineer (`227d0125-9d34-4287-8ee8-39c4903f85b0`)
- GitHub token ref: `github-token` (secret_ref in agent env)
- Webhook secret: encrypted; test ping verified `status: success` in `plugin_webhook_deliveries`

## Known CI / PR workflow gotchas

- **CONFLICTING PRs silently block CI**: GitHub won't trigger `pull_request` workflows on a PR in `CONFLICTING` state. Always check `gh pr view <N> --json mergeable,mergeStateStatus` before wondering why CI hasn't run. Rebase to fix.
- **ai-review/verdict must be posted manually**: The `ai-review/verdict` required check is not automatically posted by the internal AI Code Reviewer. After review, post it via the GitHub Statuses API:
  ```bash
  gh api repos/Viraforge/paperclip/statuses/<SHA> \
    -X POST -f state=success -f context="ai-review/verdict" \
    -f description="PASS – ..." -f target_url="<PR URL>"
  ```
- **Deploy Vultr is `workflow_dispatch` only**: `deploy-vultr.yml` no longer triggers on push to master (removed 2026-03-18). Deploy requires:
  ```bash
  gh workflow run deploy-vultr.yml --repo Viraforge/paperclip --ref master
  ```
- **Drift check fires whenever master is ahead of VPS**: `deploy-drift-check.yml` runs on a schedule and will fail any time master has commits that haven't been deployed. This is expected and intentional — it means you need to run `deploy-vultr.yml`. It is NOT a bug and should NOT be disabled.
- **Lockfile changes must go through `refresh-lockfile.yml`**: Never commit `pnpm-lock.yaml` manually in a PR — `pr-policy` will block it. The correct path when the lockfile is stale:
  1. Trigger the workflow: `gh workflow run refresh-lockfile.yml --repo Viraforge/paperclip --ref master`
  2. The workflow pushes the updated lockfile to branch `chore/refresh-lockfile` but **cannot create the PR** (GitHub Actions lacks PR creation permission in this repo).
  3. Open the PR manually: `gh pr create --repo Viraforge/paperclip --head chore/refresh-lockfile --base master --title "chore(lockfile): refresh pnpm-lock.yaml" --body "Auto-generated lockfile refresh."`
  4. Post `ai-review/verdict`, then merge. The `pr-policy` check has a built-in exception for the `chore/refresh-lockfile` branch.
- **npm package scope is `@paperclipai/`**: All packages use the upstream `@paperclipai/` scope and are marked `"private": true`. We do NOT publish to npm — packages are consumed only within the monorepo via pnpm workspace protocol. This alignment with upstream's scope eliminates merge conflicts on upgrades.

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

## Production deployment policy (GitHub-only)

This is the enforced operating policy for production changes:

- No hot fixes directly on the VPS.
- No direct source edits under `/opt/paperclip` on the VPS.
- No manual `docker compose up/build` on production hosts for application updates.
- No emergency patching outside git history.
- Every production change must be:
  1. committed to GitHub,
  2. validated by required checks (`verify` + `policy`),
  3. merged to `master`,
  4. deployed through GitHub Actions workflows only.

### Allowed paths

- Standard deploy: merge to `master`, then run approved workflow path.
- Emergency deploy: use `workflow_dispatch` from a committed branch/commit in GitHub; still no VPS source edits.

### Explicitly forbidden commands on production for app changes

- `git reset --hard` against production source as a hot-fix mechanism
- `sed -i` / ad-hoc patching of tracked source files on VPS
- `docker compose -f docker-compose.quickstart.yml up --build` for production updates
- editing workflow files or server code directly on the server and restarting containers

### Compliance verification

- Drift monitor must remain enabled (`deploy-drift-check.yml`).
- Branch protection must keep `enforce_admins=true` and required checks `verify` + `policy`.
- If drift is detected, fix via GitHub PR + CI deploy, not by patching the VPS.

## Engineering responsibility model (current)

This is the active engineering lifecycle model across repositories.

### Role separation

- Developers author software:
  - Senior Codex Developer
  - Senior Claude Code Engineer
  - Senior Gemini Frontend Engineer
  - Founding Engineer
- AI Code Reviewer evaluates all PRs and assigns severity + verdict.
- Senior Platform Engineer executes GitHub operations (branch/PR/update/merge/pipeline actions).
- Release Manager controls deployment timing and release risk.
- CTO owns technical execution and weekly engineering metrics.

No single agent should create, approve, and deploy the same change end-to-end.

### Required software pipeline

Developer writes code
-> Platform Engineer opens/updates PR
-> AI Code Reviewer reviews
-> Developer addresses findings
-> Platform Engineer applies PR updates
-> AI Code Reviewer final verdict (`PASS`, `PASS WITH NOTES`, `BLOCK`)
-> Platform Engineer merges
-> Release Manager schedules release
-> Platform Engineer executes deploy workflow

### Review loop rule

Review feedback returns to the author agent directly.
The Platform Engineer is not a reviewer-developer communication relay.

Correct loop:

AI Code Reviewer comments
-> Author agent prepares fixes
-> Platform Engineer applies fixes to PR branch
-> AI Code Reviewer re-checks

### High-risk categories

Treat these as high-risk changes:

- Auth/authz logic
- Secrets/env handling
- CI/CD workflow changes
- Infrastructure config
- Database migrations
- Billing/payment logic
- Destructive operations

High-risk PRs require extra caution and may require human review.

### Alfred and non-engineering support roles

- Alfred provides systems/tooling/integration support only.
- Alfred does not author production code and does not approve merges.
- Compliance Attorney can request additional review on high-risk or regulated changes.

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

**Cloudflare** credentials use an **API Token** with `Authorization: Bearer`:
```bash
curl -s "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer <token>"
# Expect: {"result":{"status":"active"},"success":true,...}
```

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
| `cloudflare-api-key` | Cloudflare API Token (Bearer) | Senior Platform Engineer |
| `github-token-viraforge` | GitHub PAT for `viraforge-ai` (ViraForge company account, `nydamon+paperclip@gmail.com`) | Senior Platform Engineer |
| `gws-service-account-key` | Google Workspace service account JSON key with domain-wide delegation (42 scopes, project `gam-project-2oeyh`) | Senior Platform Engineer |
| `gws-oauth2-refresh-token` | Google Workspace OAuth2 refresh token for `damon@prsecurelogistics.com` (backup / user-level access) | Senior Platform Engineer |
| `gws-client-secret` | Google Workspace GAM OAuth2 client secret (project `gam-project-2oeyh`) | Senior Platform Engineer |

`GWS_CLIENT_ID`, `GWS_ADMIN_EMAIL`, and `GWS_DOMAIN` are stored as plain env values in the Senior Platform Engineer's adapter config (not sensitive).

`CLOUDFLARE_TOKEN` is a `secret_ref` in the Senior Platform Engineer's adapter config (injected as a Bearer token; no email header needed).

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

**Policy: GitHub tokens are held exclusively by the Senior Platform Engineer. No other agent receives any GitHub token. Engineers that need a Git push must create a subtask for the Senior Platform Engineer.**

When the board needs to push a branch manually (e.g. a branch with `.github/workflows/` files that needs `workflow` scope), use the board-level push procedure documented below — do NOT give the token to the requesting agent.

| Operation | Token to use | Why |
|---|---|---|
| Push any branch containing `.github/workflows/` | `GITHUB_TOKEN` | Only classic PAT has `workflow` scope — fine-grained PATs will always 401 |
| Create/push to repo in `viraforge` org | `GITHUB_TOKEN_VIRAFORGE` | viraforge-ai is org member, keeps commits under ViraForge identity |
| Create/push to personal `nydamon` repos | `GITHUB_TOKEN` | Classic PAT; do NOT use `GITHUB_TOKEN_FG` — fine-grained PAT has no org visibility |
| GitHub Actions workflow triggers | `GITHUB_TOKEN` | has `workflow` scope |
| Fallback if VIRAFORGE token fails | `GITHUB_TOKEN` | nydamon is org admin with `repo` scope |

### Board-level push procedure (for workflow-scoped pushes)

When an agent reports "PAT missing workflow scope", the board should push manually:

```bash
# 1. Find which workspace has the branch
docker exec paperclip-server-1 bash -c '
  find /paperclip/instances/default/workspaces -name HEAD -path "*/.git/HEAD" | while read h; do
    repo=$(dirname $(dirname $h))
    branch=$(git -C "$repo" branch --list <branch-name> 2>/dev/null)
    [ -n "$branch" ] && echo "FOUND: $repo"
  done
'

# 2. Push using the workflow-scoped token (via board decrypt script)
# Use the decrypt-and-push pattern from the gen-secrets playbook.
# ALWAYS restore the remote URL to https://github.com/... after the push.
```

**Root cause of recurring "workflow scope" errors:** Agents that have both `GITHUB_TOKEN` and `GITHUB_TOKEN_FG` in their env tend to pick `GITHUB_TOKEN_FG` (fine-grained, no workflow scope) when pushing, causing 403s on workflow file changes. The permanent fix is to never give `GITHUB_TOKEN_FG` to any agent — if an agent needs Git push access at all, give them only `GITHUB_TOKEN`.

### GitHub org: `viraforge`

- `nydamon` — org admin
- `viraforge-ai` — org member (added 2026-03-14)
- The correct org name is `viraforge` (not `viraforge-labs` — that org does not exist)

---

## Connie Wallet Custody Chain (Phase 1)

Imported March 2026. Do not rotate or revoke without board approval.

### Asset facts

| Field | Value |
|-------|-------|
| Address | `0xa2e4B81f2CD154A0857b280754507f369eD685ba` |
| Network | Base mainnet (chain ID `8453`) |
| Token | USDbC (`0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA`) |
| Balance at import | ~`$10.08 USDbC` |
| Source | Connie VPS `/root/.automaton-research-home/.automaton/wallet.json` |
| Owner | DLD Ent. board |

### Paperclip secret

| Field | Value |
|-------|-------|
| Secret name | `connie-wallet-private-key` |
| Secret ID | `bf9909ac-eb5a-452e-8bdb-e2d39194070f` |
| Provider | `local_encrypted` (AES-256-GCM, master key in `paperclip-server-1`) |
| Company ID | `f6b6dbaa-8d6f-462a-bde7-3d277116b4fb` (DLD Ent.) |

### Agent binding policy

| Env key | Type | Authorized agents |
|---------|------|-------------------|
| `CONNIE_WALLET_PRIVATE_KEY` | `secret_ref` | Treasury Operator (`d6f1aff9-8a41-4225-8ff2-fabc07e3476d`) only |
| `CONNIE_WALLET_ADDRESS` | `plain` | Any agent referencing wallet publicly |
| `CONNIE_WALLET_CHAIN_ID` | `plain` | Any agent |
| `CONNIE_WALLET_NETWORK` | `plain` | Any agent |
| `CONNIE_WALLET_TOKEN_CONTRACT` | `plain` | Any agent |

Only the CEO role can add or remove `secret_ref` bindings via `PATCH /api/agents/:id/permissions`.

### Wallet helper code

- `server/src/wallet/connie-wallet.ts` — `getAddressFromKey`, `validateWalletEnv`, `signMessageWithEnvKey`
- `server/src/wallet/signer-service.ts` — `SignerService` interface + phase-1 env shim; phase-2 target

### Revocation procedure

To stop signing access without destroying the secret:

```bash
# Remove secret_ref from Treasury Operator env (patch via DB or CEO-auth API)
ssh -i "/Users/damondecrescenzo/.ssh/paperclip-gha-deploy" root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip \
    -c \"UPDATE agents SET adapter_config = adapter_config #- '{env,CONNIE_WALLET_PRIVATE_KEY}', updated_at = now() \
         WHERE id = 'd6f1aff9-8a41-4225-8ff2-fabc07e3476d';\""

# Confirm the key is gone from the agent env
docker exec paperclip-db-1 psql -U paperclip paperclip -t \
  -c "SELECT adapter_config->'env' FROM agents WHERE id='d6f1aff9-8a41-4225-8ff2-fabc07e3476d';"
```

The encrypted secret record is preserved for recovery. Delete the `company_secrets` row only if compromise is confirmed.

### Key rotation procedure

1. Generate a new EVM wallet on a secure, air-gapped machine.
2. Fund from current address via a Base bridge or direct transfer.
3. Import new key as a new version of `connie-wallet-private-key` via the gen-secrets script.
4. Update `CONNIE_WALLET_ADDRESS` plain value on all agents.
5. Confirm new address is resolving correctly in heartbeat logs.
6. Remove old key version (retain record; delete sensitive material only).

### Phase-2 migration path

See `server/src/wallet/signer-service.ts` for the `SignerService` interface. Phase-2 removes `CONNIE_WALLET_PRIVATE_KEY` from agent env entirely; agents call the signer service endpoint and never see the raw key.
