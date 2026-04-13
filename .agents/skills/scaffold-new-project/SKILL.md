---
name: scaffold-new-project
description: >
  Scaffold a new Darwin Agency project from scratch: create a GitHub repo,
  apply the right tech stack template, wire the Railway sandbox deploy pipeline,
  set GitHub secrets, push an initial commit, and report the live sandbox URL
  back on the parent Paperclip issue. Use whenever a Scaffold subtask is assigned
  by the CTO as part of the Idea Incubator pipeline.
---

# scaffold-new-project

Use this skill when you receive a `Scaffold: <project-name>` subtask from the CTO. It walks you through all eight steps from repo creation to a live sandbox URL.

## When to Use

- You are assigned a subtask titled `Scaffold: <name>` (created by CTO during idea scoping)
- The subtask description contains: project name, stack name, and a feature list
- You need to go from zero to a running sandbox URL

## Prerequisites (verify before starting)

```bash
gh auth status                          # GitHub CLI authenticated
railway --version                       # Railway CLI installed
ls /home/r1kon/repos/                   # Repos base dir exists
[ -n "$RAILWAY_TOKEN" ] || source /home/r1kon/.paperclip/instances/default/secrets/railway.env
echo "RAILWAY_TOKEN set: ${RAILWAY_TOKEN:0:8}..."   # verify token loaded
```

If `railway` is not installed: `npm install -g @railway/cli@latest`
If `/home/r1kon/repos/` doesn't exist: `mkdir -p /home/r1kon/repos/`

## Required Inputs (from subtask description)

| Field | Example |
|---|---|
| `PROJECT_NAME` | `invoice-tracker` |
| `STACK` | `nextjs`, `nextjs-shadcn`, `laravel`, `nuxt`, `express` |
| `FEATURES` | Brief feature list (for context only — build happens in later subtasks) |
| `PAPERCLIP_PARENT_ISSUE` | The parent DAR issue identifier (e.g. `DAR-55`) |

## Step 1 — Pre-flight

```bash
gh auth status
railway --version
ls /home/r1kon/repos/
```

Abort and comment on the issue if any check fails. Describe what is missing so the CTO can unblock.

## Step 2 — Create GitHub Repo

**Preferred: use a Darwin template repo (if available for the stack).**

Check the Darwin template registry first:

```bash
cat /home/r1kon/repos/registry.json | python3 -c "import sys,json; [print(r['name'], r.get('githubUrl','')) for r in json.load(sys.stdin) if r.get('isTemplate')]"
```

| STACK value | Template repo (use when available) |
|---|---|
| `laravel-saas` | `KEatonDarwin/laravel-saas` |
| `laravel-api` | `KEatonDarwin/laravel-api` |
| `nextjs-saas` | `KEatonDarwin/nextjs-saas` |
| others | no template yet — scaffold from scratch (Step 3) |

**If a matching template exists:**

```bash
cd /home/r1kon/repos/
gh repo create KEatonDarwin/$PROJECT_NAME \
  --template KEatonDarwin/$STACK \
  --private \
  --clone \
  --description "Darwin Agency — $PROJECT_NAME"
cd $PROJECT_NAME
# Skip Step 3 — template already includes full boilerplate, CI/CD, and Railway config
# Proceed directly to Step 5 (Railway provisioning)
```

**If no matching template exists (scaffold from scratch):**

```bash
cd /home/r1kon/repos/
gh repo create KEatonDarwin/$PROJECT_NAME \
  --private \
  --clone \
  --description "Darwin Agency — $PROJECT_NAME"
cd $PROJECT_NAME
```

> **Note:** If Kevin has created the `DarwinAgencyTech` GitHub org, use `DarwinAgencyTech/$PROJECT_NAME` instead.

## Step 3 — Apply Stack Template (scratch only — skip if using Darwin template)

Choose the command matching `STACK`:

```bash
# nextjs (default full-stack)
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"

# nextjs-shadcn (admin/dashboard)
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"
# then:
npx shadcn@latest init --defaults

# nuxt
npx nuxi@latest init .

# laravel (Darwin stack: Laravel + Inertia + Vue)
composer create-project laravel/laravel .
composer require laravel/breeze --dev
php artisan breeze:install vue --inertia
npm install

# express (Node API/backend)
npm init -y
npm install express
npm install -D typescript ts-node @types/express @types/node
npx tsc --init
# create src/index.ts with a minimal Express app
```

After running the template command, commit the scaffold:

```bash
git add -A
git commit -m "chore: scaffold $PROJECT_NAME ($STACK)

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

## Step 4 — Wire CI/CD (scratch only — skip if using Darwin template)

Copy the reference deploy workflow from the Darwin Agency runbook:

```bash
mkdir -p .github/workflows
cp /home/r1kon/.paperclip/instances/default/paperclip-wiki/runbooks/deploy-sandbox.yml.template \
   .github/workflows/deploy-sandbox.yml
```

Commit:

```bash
git add .github/workflows/deploy-sandbox.yml
git commit -m "ci: add Railway sandbox deploy pipeline

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

## Step 5 — Provision Railway Project

```bash
# Load token if needed (Railway CLI reads RAILWAY_TOKEN automatically)
if [ -z "$RAILWAY_TOKEN" ]; then
  source /home/r1kon/.paperclip/instances/default/secrets/railway.env
fi

railway init           # creates a new Railway project; choose "Empty Project" when asked
railway environment    # verify "production" environment exists
```

Create a `sandbox` environment:
- Open the Railway dashboard URL printed by `railway init`
- Click **New Environment** → name it `sandbox`

Or via CLI (if supported in current Railway version):
```bash
railway environment create sandbox 2>/dev/null || echo "Create 'sandbox' env in Railway dashboard"
```

Link the repo to Railway:
```bash
railway link           # select the project you just created
```

Get the service ID:
```bash
railway status         # note the SERVICE_ID from output
```

## Step 6 — Set GitHub Secrets

```bash
# Load RAILWAY_TOKEN from secrets file if not already in environment
if [ -z "$RAILWAY_TOKEN" ]; then
  source /home/r1kon/.paperclip/instances/default/secrets/railway.env
fi

# Verify token is set
if [ -z "$RAILWAY_TOKEN" ]; then
  echo "ERROR: RAILWAY_TOKEN not found. Post blocked comment on issue."
  exit 1
fi

railway service         # confirm service name
RAILWAY_SERVICE_ID=$(railway status --json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('serviceId',''))" 2>/dev/null || echo "MANUAL")

# Set GitHub secrets (non-interactive using env vars)
gh secret set RAILWAY_TOKEN --body "$RAILWAY_TOKEN"
gh secret set RAILWAY_SERVICE_ID --body "$RAILWAY_SERVICE_ID"
```

If `RAILWAY_TOKEN` is still not available after sourcing the secrets file, post a `blocked` comment on the issue asking the CTO to add the token to `/home/r1kon/.paperclip/instances/default/secrets/railway.env`.

## Step 7 — Push & Deploy

```bash
git push -u origin main
```

Watch the deploy (GitHub Actions + Railway):

```bash
gh run watch           # monitor the Actions run
```

The sandbox URL follows the convention:
`https://$PROJECT_NAME.railway.app` (Railway-assigned, until custom DNS is configured)

Wait for the deploy to complete (~5–10 min for first deploy). Verify the URL returns a 200.

```bash
curl -s -o /dev/null -w "%{http_code}" https://$PROJECT_NAME.up.railway.app
```

## Step 8 — Register in Paperclip & Report

Register the repo as a Paperclip project workspace:

```bash
curl -s -X POST "$PAPERCLIP_API_URL/api/projects/$PROJECT_ID/workspaces" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"cwd\": \"/home/r1kon/repos/$PROJECT_NAME\", \"repoUrl\": \"https://github.com/KEatonDarwin/$PROJECT_NAME\"}"
```

Mark the scaffold subtask **done** and post a comment on the **parent issue** with:

```markdown
## Scaffold Complete — $PROJECT_NAME

**Sandbox URL:** https://$PROJECT_NAME.up.railway.app

**Stack:** $STACK | **Repo:** https://github.com/KEatonDarwin/$PROJECT_NAME

Next steps:
- Feature subtasks are queued — ClaudeCoder will begin building
- Each PR merge auto-redeploys the sandbox
- Drop feedback here as comments or new subtasks
```

## Stack Quick-Reference

| Kevin's intent | STACK value | Darwin template? |
|---|---|---|
| SaaS app with teams, auth, multi-tenant (PHP/Vue) | `laravel-saas` | Yes — `KEatonDarwin/laravel-saas` |
| SaaS app with teams, auth, multi-tenant (PHP/React) | `laravel-saas-react` | Yes — `KEatonDarwin/laravel-saas-react` |
| Headless API, webhooks, backend service (PHP) | `laravel-api` | Yes — `KEatonDarwin/laravel-api` |
| Background jobs, queues, webhooks, pipelines (PHP) | `laravel-jobs-worker` | Yes — `KEatonDarwin/laravel-jobs-worker` |
| Server-rendered dashboard / back-office (PHP/Blade) | `laravel-blade-mvc` | Yes — `KEatonDarwin/laravel-blade-mvc` |
| Reactive PHP panel with live data, kiosk option | `laravel-livewire-panel` | Yes — `KEatonDarwin/laravel-livewire-panel` |
| SaaS app with teams, auth, multi-tenant (Next.js) | `nextjs-saas` | Yes — `KEatonDarwin/nextjs-saas` |
| Kiosk / wall display, polling data, no auth | `nextjs-kiosk` | Yes — `KEatonDarwin/nextjs-kiosk` |
| SaaS app with teams, auth, multi-tenant (Nuxt/Vue) | `nuxt-saas` | Yes — `KEatonDarwin/nuxt-saas` |
| Landing page, marketing site, blog, docs | `astro-marketing` | Yes — `KEatonDarwin/astro-marketing` |
| Dashboard, admin, internal tool (Next.js + shadcn) | `nextjs-shadcn` | No — scaffold from scratch |
| API, backend, webhook, service (Node) | `express` | No — scaffold from scratch |
| Unclear / general | `nextjs-saas` | Yes — use Darwin template |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `railway: command not found` | `npm install -g @railway/cli@latest` |
| `gh: command not found` | Check `gh` is installed; `gh auth login` |
| `gh repo create` fails | Verify you have access to `KEatonDarwin` org |
| Railway deploy hangs | Check Actions tab on GitHub; `railway logs` |
| Sandbox URL 502 / not found | Railway deploy may still be in progress; wait 2 min and retry |
| `RAILWAY_TOKEN` not set | Post `blocked` comment on issue; ask CTO for token |
