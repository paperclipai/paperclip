# PM Dispatch & Project Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the ProjectManager agent to (1) automatically ingest GitHub issues as Paperclip tasks every 30 minutes and (2) auto-onboard any new empty project by reading its repo and populating a documentation hub.

**Architecture:** All behaviour lives in the PM's `AGENTS.md` instructions file plus one new Paperclip routine (the 30-min cron). The PM reads instructions on every heartbeat; adding new sections is sufficient to enable both features. Deduplication is handled by the `[GH#N]` title prefix convention — PM checks existing task titles before creating anything new.

**Tech Stack:** Paperclip API (HTTP/JSON), GitHub CLI (`gh`), PM's `claude_local` adapter (reads AGENTS.md), `bash` for API calls in verification steps.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `/home/martins/.paperclip/instances/default/companies/a93b263d-5f67-480b-aba7-9359a431b98e/agents/d54b0b54-64f9-4b2b-aed7-5cffa4b9dd00/instructions/AGENTS.md` | Modify | Add GitHub Dispatch and Project Onboarding sections |
| Paperclip API | Create routine | 30-min dispatch cron assigned to PM |

---

## Task 1: Ensure Required GitHub Labels Exist

The dispatch and onboarding routines apply labels to GH issues. Ensure the needed labels exist on `mrveiss/AutoBot-AI` before PM tries to apply them.

**Files:** none (GitHub API only)

- [ ] **Step 1: Check which labels are missing**

```bash
NEEDED="setup docs review merge triage"
for label in $NEEDED; do
  EXISTS=$(gh api repos/mrveiss/AutoBot-AI/labels --jq ".[].name" | grep -x "$label" || echo "")
  [ -z "$EXISTS" ] && echo "MISSING: $label" || echo "OK: $label"
done
```

- [ ] **Step 2: Create any missing labels**

```bash
# Create each missing label (skip if already exists)
gh api repos/mrveiss/AutoBot-AI/labels -X POST \
  -f name="setup" -f color="0075ca" -f description="Environment, provisioning, or service setup" 2>/dev/null || true

gh api repos/mrveiss/AutoBot-AI/labels -X POST \
  -f name="docs" -f color="e4e669" -f description="Documentation gap or improvement" 2>/dev/null || true

gh api repos/mrveiss/AutoBot-AI/labels -X POST \
  -f name="review" -f color="d93f0b" -f description="PR needs review" 2>/dev/null || true

gh api repos/mrveiss/AutoBot-AI/labels -X POST \
  -f name="merge" -f color="0e8a16" -f description="PR approved and ready to merge" 2>/dev/null || true

gh api repos/mrveiss/AutoBot-AI/labels -X POST \
  -f name="triage" -f color="e11d48" -f description="Needs owner or classification" 2>/dev/null || true
```

- [ ] **Step 3: Verify all labels exist**

```bash
gh api repos/mrveiss/AutoBot-AI/labels --jq '.[].name' | sort
```

Expected output includes: `bug`, `ci`, `docs`, `merge`, `review`, `setup`, `triage`

- [ ] **Step 4: Commit a note**

```bash
cd /home/martins/paperclip
git commit --allow-empty -m "chore: ensure required GH labels exist on mrveiss/AutoBot-AI

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Add GitHub Issue Dispatch Section to PM AGENTS.md

Add the dispatch instructions as a new section in the PM's AGENTS.md. Place it after the existing `## INTAKE` section.

**Files:**
- Modify: `...agents/d54b0b54-.../instructions/AGENTS.md` (after line ~52, after the INTAKE section)

- [ ] **Step 1: Read the current AGENTS.md to find the insertion point**

```bash
grep -n "^## " /home/martins/.paperclip/instances/default/companies/a93b263d-5f67-480b-aba7-9359a431b98e/agents/d54b0b54-64f9-4b2b-aed7-5cffa4b9dd00/instructions/AGENTS.md
```

Find the line number of `## Fibonacci Task Sizing` — insert the new section just before it.

- [ ] **Step 2: Insert the GitHub Dispatch section**

Open the file and insert the following block immediately before `## Fibonacci Task Sizing and Decomposition`:

```markdown
## GitHub Issue Ingestion

Run this after the INTAKE routing step, every heartbeat.

### Step 1 — Fetch open GH issues

```bash
gh issue list --repo mrveiss/AutoBot-AI --state open \
  --json number,title,body,labels,createdAt --limit 200
```

### Step 2 — Deduplicate against existing Paperclip tasks

Fetch existing tasks:
```bash
GET /api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/issues?status=todo,in_progress,in_review,blocked,backlog&limit=500
```

A GH issue is already tracked if ANY existing Paperclip task title contains `[GH#<number>]`.
**Skip it entirely** — do not create a duplicate, do not update the existing task, do not comment.
Also skip issues where a `done` or `cancelled` Paperclip task exists AND the GH issue is still open —
this means the fix was attempted; create a NEW task only if the GH issue has been updated since the task closed.

### Step 3 — Sort untracked issues by priority

Process in this order:
1. Title starts with `fix(`, `bug(`, `hotfix(` — OR label includes `bug` or `critical`
2. Title starts with `discovery(`
3. Everything else (`feat(`, `design(`, `ux(`, `chore(`)

Within each tier: oldest first (lowest GH issue number first).

### Step 4 — Check concurrency gate

```bash
GET /api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/agents
```

Count agents where `status == "running"` and role is `engineer`. If 2 or more IC engineers are running → **stop, dispatch nothing this cycle**. Post no comment. Try again next heartbeat.

Per-agent gate: if an agent already has ≥ 2 tasks in `in_progress` or `in_review` → skip that agent this cycle, try their assistant fallback instead.

### Step 5 — Dispatch up to 5 issues

For each of the top 5 untracked issues (after sorting and gating):

**Assess complexity** (any 2+ signals → complex):
- Body > 300 words
- Multiple system components mentioned (backend + frontend + CI, etc.)
- Keywords: "integrate", "refactor", "migrate", "full", "system", "overhaul", "phase", "end-to-end"
- Cross-cutting: touches more than one agent specialty

**Simple → one task:**
```bash
POST /api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/issues
{
  "title": "[GH#<number>] <original title>",
  "description": "Imported from GitHub issue #<number>.\n\n<first 500 chars of body>\n\nGH URL: https://github.com/mrveiss/AutoBot-AI/issues/<number>",
  "status": "todo",
  "priority": "<critical|high|medium|low based on tier>",
  "assigneeAgentId": "<routed agent id>",
  "projectId": "<project id matching repo, or Autobot project 22d17c44-a12c-4913-b389-8c1690ea4b25 by default>"
}
```

**Complex → parent + children** (see Fibonacci Decomposition section below for decomposition rules):
- Create parent task: `[GH#<number>] <title>`, status `blocked`
- Create 2–5 child tasks: `[<Npt>] [GH#<number>-<i>] <subtask title>`, each ≤ 5pt
- Set `parentId` and `blockedByIssueIds` on parent
- Route children to assistant-tier agents for bounded implementation subtasks

### Routing table

Read the issue title + first 200 chars of body. Pick the best-fit agent:

| Topic signals | Primary | Assistant fallback |
|---|---|---|
| Python, FastAPI, backend API, Redis, database, config | `97ca3669-ee7c-400a-bd3e-774d417022d1` BackendEngineer | `f6434ce4-ca56-4881-ba9d-a07938ea3b4a` BackendAssistant |
| Vue, TypeScript, frontend, UI, components, Storybook | `fbc60351-211d-427a-ad28-27d609e80a4c` SeniorFrontendDeveloper | `f4e81b79-1bfb-42d7-84c8-0cff20353081` FrontendAssistant |
| CI/CD, Docker, Ansible, provisioning, SLM, fleet | `9c6116f1-e429-453e-a288-30e88c11e182` DevOpsEngineer | `f6f46105-5213-42df-977d-17e993d66838` DevOpsAssistant |
| Security, auth, RBAC, audit, compliance | `b49788d7-334a-4cd4-b046-42c12f4d9af5` SecurityEngineer | `51731530-7df1-4f03-a642-c5149069c606` SecurityAssistant |
| Architecture, system design, ADR, cross-stack | `24536e3f-a21f-4ed9-950f-e883654cab27` SeniorCodeArchitect | `bd23c291-6eb5-4f24-9dd5-accd9775a452` ArchitectAssistant |
| No clear match | `a074bb26-f1d0-4009-842b-1bdb109367ec` CTO | — |
```

- [ ] **Step 3: Verify the section was inserted cleanly**

```bash
grep -n "GitHub Issue Ingestion\|Fibonacci Task Sizing" \
  /home/martins/.paperclip/instances/default/companies/a93b263d-5f67-480b-aba7-9359a431b98e/agents/d54b0b54-64f9-4b2b-aed7-5cffa4b9dd00/instructions/AGENTS.md
```

Expected: `## GitHub Issue Ingestion` appears before `## Fibonacci Task Sizing`.

- [ ] **Step 4: Commit**

```bash
cd /home/martins/paperclip
git add docs/  # if any doc changed
git commit -m "feat(pm): add GitHub issue dispatch section to PM instructions

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Create the 30-Minute Dispatch Routine

Create the Paperclip routine that wakes PM every 30 minutes to run the dispatch. PM's heartbeat already has a 600-second timer, but this routine provides an explicit scheduled wake with a clear description.

**Files:** Paperclip API only

- [ ] **Step 1: Create the routine**

```bash
curl -s -X POST "http://localhost:3100/api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/routines" \
  -H "Authorization: Bearer local-trusted" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "d54b0b54-64f9-4b2b-aed7-5cffa4b9dd00",
    "description": "GitHub Issue Dispatch: run the GitHub Issue Ingestion section of your instructions. Fetch open issues from mrveiss/AutoBot-AI, deduplicate against existing Paperclip tasks, sort by priority, and dispatch up to 5 untracked issues as Paperclip tasks. Respect the concurrency gate. Mark this execution issue done when complete.",
    "triggers": [{
      "kind": "schedule",
      "label": "gh-issue-dispatch-30min",
      "cronExpression": "*/30 * * * *",
      "timezone": "Europe/Riga",
      "enabled": true
    }]
  }' | jq '{id, agentId: .agentId, triggers: [.triggers[] | {label, cronExpression, enabled}]}'
```

- [ ] **Step 2: Verify the routine was created**

```bash
curl -s "http://localhost:3100/api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/routines" \
  -H "Authorization: Bearer local-trusted" | jq '[.[] | select(.description | contains("gh-issue-dispatch")) | {id, triggers: [.triggers[] | .label]}]'
```

Expected: one routine with label `gh-issue-dispatch-30min`.

- [ ] **Step 3: Commit**

```bash
cd /home/martins/paperclip
git commit --allow-empty -m "feat(pm): create 30-min GitHub issue dispatch routine in Paperclip

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Add Project Onboarding Section to PM AGENTS.md

Add the project onboarding instructions as a section that runs after GitHub dispatch on every heartbeat.

**Files:**
- Modify: `...agents/d54b0b54-.../instructions/AGENTS.md` (append after GitHub Ingestion section)

- [ ] **Step 1: Append the Project Onboarding section**

Add the following block at the end of the AGENTS.md file (before the final `## Done` section):

```markdown
## Project Onboarding

Run after GitHub Issue Ingestion. Detect and onboard any uninitialised projects.

### Step 1 — Detect uninitialised projects

```bash
GET /api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/projects
```

For each project: check if any issue exists with `[Docs]` in the title and `projectId` matching this project.

```bash
GET /api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/issues?projectId=<id>&limit=100
```

If no `[Docs]` issue found → project is uninitialised. Extract the GitHub repo URL from the project description. If no URL present → create a `[Onboarding] <name> — needs GitHub repo URL` issue assigned to CEO (`cef2fd38-5cfb-4622-9034-4e5383ec6aa7`) and skip this project.

**Onboard only one project per heartbeat** to avoid budget overrun.

### Step 2 — Read the repo

```bash
# Read core docs
gh api repos/<owner>/<repo>/contents/README.md --jq '.content' | base64 -d 2>/dev/null
gh api repos/<owner>/<repo>/contents/CONTRIBUTING.md --jq '.content' | base64 -d 2>/dev/null
gh api repos/<owner>/<repo>/contents/DEVELOPMENT.md --jq '.content' | base64 -d 2>/dev/null

# List and read docs/ directory
gh api "repos/<owner>/<repo>/git/trees/HEAD?recursive=1" \
  --jq '.tree[] | select(.path | test("^docs/.*\\.md$")) | .path' | head -20

# Read each docs file found (up to 10)
# gh api repos/<owner>/<repo>/contents/<path> --jq '.content' | base64 -d

# Dependency manifests
gh api repos/<owner>/<repo>/contents/.env.example --jq '.content' | base64 -d 2>/dev/null
gh api repos/<owner>/<repo>/contents/docker-compose.yml --jq '.content' | base64 -d 2>/dev/null

# For AutoBot subprojects also check:
# autobot-slm-backend/ansible/roles/*/README.md
# autobot-backend/docs/

# GitHub state
gh issue list --repo <owner>/<repo> --state open \
  --json number,title,body,labels,createdAt --limit 200
gh pr list --repo <owner>/<repo> --state open \
  --json number,title,reviewDecision,statusCheckRollup,createdAt --limit 50
```

### Step 3 — Create the Documentation Hub issue

```bash
POST /api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/issues
{
  "title": "[Docs] <Project Name> — Project Documentation Hub",
  "description": "Central documentation for <Project Name>. Repo: <GitHub URL>",
  "projectId": "<project-id>",
  "status": "in_progress",
  "priority": "high",
  "label": "docs"
}
```

Then create all five documents on this issue using content extracted from the repo:

```bash
PUT /api/issues/<hub-issue-id>/documents/prd
{ "title": "Product Requirements", "format": "markdown", "body": "<extracted content>", "baseRevisionId": null }

PUT /api/issues/<hub-issue-id>/documents/tech-stack
{ "title": "Technical Stack", "format": "markdown", "body": "<extracted content>", "baseRevisionId": null }

PUT /api/issues/<hub-issue-id>/documents/access-guide
{ "title": "Access & Credentials Guide", "format": "markdown", "body": "<extracted content>", "baseRevisionId": null }

PUT /api/issues/<hub-issue-id>/documents/architecture
{ "title": "Architecture Notes", "format": "markdown", "body": "<extracted content>", "baseRevisionId": null }

PUT /api/issues/<hub-issue-id>/documents/runbooks
{ "title": "Runbooks", "format": "markdown", "body": "<extracted content>", "baseRevisionId": null }
```

Populate each document from the repo. Unknown sections use `_Not yet documented_`. Never leave a section blank.

### Step 4 — Create Kickoff issue

```bash
POST /api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/issues
{
  "title": "[Kickoff] <Project Name> — goals, scope, and first sprint",
  "projectId": "<project-id>",
  "status": "todo",
  "priority": "high",
  "label": "setup"
}
```

### Step 5 — Sub-issue tree from findings

For each finding (setup gap, docs gap, critical GH issue, actionable PR), create a child issue of the kickoff with `parentId` set. Group under category parent issues:

- `[Onboarding] Setup — environment & services`
- `[Onboarding] Docs gaps`
- `[Onboarding] GitHub issues — critical` (bug/fix GH issues only; backlog feat issues → leave for dispatch routine)
- `[Onboarding] Pull requests — action needed`

Every child issue must have: `projectId` (Operations: `bdb497cb-e7cb-421b-ad1d-b68e7f0b48b8`), label, `parentId`, `assigneeAgentId`.

Apply missing labels back to GH where found:
```bash
gh issue edit <number> --repo <owner>/<repo> --add-label "bug"
```

### Step 6 — Update PM dispatch to include new repo

Add the new repo to the GitHub Issue Ingestion sweep by noting it in the execution issue comment so the board knows:
```
POST /api/issues/<execution-issue-id>/comments
{ "body": "Onboarded <Project Name> (repo: <owner>/<repo>). Added to dispatch sweep." }
```
```

- [ ] **Step 2: Verify the section appears at the end of AGENTS.md**

```bash
tail -20 /home/martins/.paperclip/instances/default/companies/a93b263d-5f67-480b-aba7-9359a431b98e/agents/d54b0b54-64f9-4b2b-aed7-5cffa4b9dd00/instructions/AGENTS.md
```

Expected: `## Project Onboarding` section is present.

- [ ] **Step 3: Commit**

```bash
cd /home/martins/paperclip
git commit -m "feat(pm): add project onboarding section to PM instructions

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Smoke-Test the Dispatch Routine

Verify the PM ingests GH issues and does not create duplicates on a second run.

**Files:** None (verification only)

- [ ] **Step 1: Record baseline — count existing Paperclip tasks**

```bash
BEFORE=$(curl -s "http://localhost:3100/api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/issues?status=todo,backlog&limit=500" \
  -H "Authorization: Bearer local-trusted" | jq '[.[] | select(.title | startswith("[GH#"))] | length')
echo "Tasks before: $BEFORE"
```

- [ ] **Step 2: Enable wakeOnDemand temporarily**

```bash
curl -s -X PATCH "http://localhost:3100/api/agents/d54b0b54-64f9-4b2b-aed7-5cffa4b9dd00" \
  -H "Authorization: Bearer local-trusted" -H "Content-Type: application/json" \
  -d '{"runtimeConfig": {"heartbeat": {"enabled": true, "intervalSec": 600, "wakeOnDemand": true, "maxConcurrentRuns": 1}}}' \
  | jq '.runtimeConfig.heartbeat.wakeOnDemand'
```

Expected: `true`

- [ ] **Step 3: Trigger PM heartbeat and wait**

```bash
npx paperclipai heartbeat run \
  --agent-id d54b0b54-64f9-4b2b-aed7-5cffa4b9dd00 \
  --source on_demand --timeout-ms 480000 2>&1 | tail -5
```

Expected: run completes (not `timed_out`). If it times out, check server logs for errors:
```bash
tail -50 /home/martins/.paperclip/instances/default/logs/server.log | grep -i "error\|warn"
```

- [ ] **Step 4: Verify new tasks were created**

```bash
AFTER=$(curl -s "http://localhost:3100/api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/issues?status=todo,backlog&limit=500" \
  -H "Authorization: Bearer local-trusted" | jq '[.[] | select(.title | startswith("[GH#"))] | length')
echo "Tasks after: $AFTER  (added: $((AFTER - BEFORE)))"

# Show the new tasks
curl -s "http://localhost:3100/api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/issues?status=todo,backlog&limit=500" \
  -H "Authorization: Bearer local-trusted" \
  | jq '[.[] | select(.title | startswith("[GH#")) | {identifier, title, assigneeAgentId}]' | head -40
```

Expected: 1–5 new `[GH#N]` tasks created, assigned to appropriate agents, highest-priority GH issues first (bug/fix before feat).

- [ ] **Step 5: Verify no duplicates on second run**

Trigger heartbeat again:
```bash
npx paperclipai heartbeat run \
  --agent-id d54b0b54-64f9-4b2b-aed7-5cffa4b9dd00 \
  --source on_demand --timeout-ms 480000 2>&1 | tail -3
```

Then check count again:
```bash
curl -s "http://localhost:3100/api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/issues?status=todo,backlog&limit=500" \
  -H "Authorization: Bearer local-trusted" | jq '[.[] | select(.title | startswith("[GH#"))] | length'
```

Expected: same count as after first run — no duplicates.

- [ ] **Step 6: Restore wakeOnDemand to false**

```bash
curl -s -X PATCH "http://localhost:3100/api/agents/d54b0b54-64f9-4b2b-aed7-5cffa4b9dd00" \
  -H "Authorization: Bearer local-trusted" -H "Content-Type: application/json" \
  -d '{"runtimeConfig": {"heartbeat": {"enabled": true, "intervalSec": 600, "wakeOnDemand": false, "maxConcurrentRuns": 1}}}' \
  | jq '.runtimeConfig.heartbeat.wakeOnDemand'
```

Expected: `false`

---

## Task 6: Smoke-Test the Onboarding Flow

Create a minimal test project and verify PM populates it.

**Files:** None (verification only)

- [ ] **Step 1: Create a test project**

```bash
TEST_PROJECT=$(curl -s -X POST "http://localhost:3100/api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/projects" \
  -H "Authorization: Bearer local-trusted" -H "Content-Type: application/json" \
  -d '{
    "name": "Test Onboarding",
    "urlKey": "test-onboarding",
    "description": "Test project for onboarding smoke test. Repo: https://github.com/mrveiss/AutoBot-AI",
    "status": "in_progress"
  }' | jq -r '.id')
echo "Created project: $TEST_PROJECT"
```

- [ ] **Step 2: Enable wakeOnDemand and trigger PM**

```bash
curl -s -X PATCH "http://localhost:3100/api/agents/d54b0b54-64f9-4b2b-aed7-5cffa4b9dd00" \
  -H "Authorization: Bearer local-trusted" -H "Content-Type: application/json" \
  -d '{"runtimeConfig": {"heartbeat": {"enabled": true, "intervalSec": 600, "wakeOnDemand": true, "maxConcurrentRuns": 1}}}' > /dev/null

npx paperclipai heartbeat run \
  --agent-id d54b0b54-64f9-4b2b-aed7-5cffa4b9dd00 \
  --source on_demand --timeout-ms 480000 2>&1 | tail -5
```

- [ ] **Step 3: Verify docs hub was created**

```bash
curl -s "http://localhost:3100/api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/issues?projectId=$TEST_PROJECT&limit=50" \
  -H "Authorization: Bearer local-trusted" \
  | jq '[.[] | {title, status}]'
```

Expected: at least one issue with `[Docs]` in the title, status `in_progress`.

- [ ] **Step 4: Verify all 5 documents exist on the hub issue**

```bash
HUB_ID=$(curl -s "http://localhost:3100/api/companies/a93b263d-5f67-480b-aba7-9359a431b98e/issues?projectId=$TEST_PROJECT&limit=50" \
  -H "Authorization: Bearer local-trusted" \
  | jq -r '[.[] | select(.title | contains("[Docs]"))][0].id')

curl -s "http://localhost:3100/api/issues/$HUB_ID/documents" \
  -H "Authorization: Bearer local-trusted" | jq '[.[] | .key]'
```

Expected: `["prd", "tech-stack", "access-guide", "architecture", "runbooks"]`

- [ ] **Step 5: Clean up test project**

```bash
curl -s -X PATCH "http://localhost:3100/api/projects/$TEST_PROJECT" \
  -H "Authorization: Bearer local-trusted" -H "Content-Type: application/json" \
  -d '{"status": "cancelled"}' | jq '.status'
```

- [ ] **Step 6: Restore wakeOnDemand**

```bash
curl -s -X PATCH "http://localhost:3100/api/agents/d54b0b54-64f9-4b2b-aed7-5cffa4b9dd00" \
  -H "Authorization: Bearer local-trusted" -H "Content-Type: application/json" \
  -d '{"runtimeConfig": {"heartbeat": {"enabled": true, "intervalSec": 600, "wakeOnDemand": false, "maxConcurrentRuns": 1}}}' > /dev/null
echo "Done"
```
