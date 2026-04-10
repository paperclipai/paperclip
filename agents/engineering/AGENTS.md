# Engineering Agents — Metacorp / Metaclip

## Company & Product

**Company:** Metacorp  
**Product:** Metaclip — our private, optimized fork of Paperclip AI.

Metacorp exists solely to improve and extend Metaclip. We have no external customers. All work is for internal or open-source use only.

## Key Repositories

| Role | URL |
|------|-----|
| Upstream reference (read-only) | https://github.com/paperclipai/paperclip |
| Our fork (active development) | https://github.com/nrdnfjrdio/Metaclip |
| Local running instance | `~/Projects/Metaclip_Dev/Metaclip` |

> **The local install is the live running instance of Metaclip. Never commit code changes directly to `master`. See the two-track workflow below.**

### Two-Track Workflow: Code vs. Governance

There are two distinct categories of change, with different rules for each:

| Category | Examples | Where to work |
|----------|----------|---------------|
| **Code / features** | Application code, configs, dependencies, migrations | GitHub feature branch only — never touch the local live repo for these |
| **Governance / rules** | `AGENTS.md`, agent instructions, process docs | May be edited directly on the live local repo |

**For code/feature changes:** The Metaclip dev server runs in watch mode — any file change in `~/Projects/Metaclip_Dev/Metaclip` is immediately hot-reloaded into the live running server. Directly modifying code on the live instance has caused breakage in the past. All code changes must go through the GitHub branch → review → board-approved merge → `git pull` workflow below.

**For governance/rules changes:** Agents may edit files like `AGENTS.md` directly in the local repo. These changes do not affect application runtime.

## Governance Rules

### What you MUST do

1. **For code changes: develop on GitHub feature branches only.** Never write code directly to the local live instance. Create the branch and make all commits via GitHub API or `gh` CLI:
   ```bash
   # Create branch on GitHub
   gh api repos/nrdnfjrdio/Metaclip/git/refs \
     -X POST -f ref="refs/heads/feature/<name>" -f sha="<master-sha>"
   ```

2. **For code changes: get board approval before merging.** All merges to `master` require explicit approval from the board via a Paperclip `merge_code` approval request. Raise a PR and link the approval before merging.

3. **For code changes: update the local repo only after an approved merge.** Once the board approves and the PR is merged to `master` on GitHub, the CTO or Internal Affairs Lead must run `git pull origin master` on the live local instance before any restart.

4. **For governance changes: edit directly on the local repo.** Files like `AGENTS.md` and agent instructions may be modified directly in `~/Projects/Metaclip_Dev/Metaclip`.

5. **Cherry-pick intentionally from upstream.** Monitor https://github.com/paperclipai/paperclip for useful changes, but never run a full sync or rebase from upstream. Review changes first, then selectively apply what is relevant.

6. **Coordinate with your commanding officer before implementing code changes.** You may research and ideacraft freely, but must get sign-off from the CTO (or the CEO for cross-cutting concerns) before beginning implementation work.

### What you must NEVER do

- **Never write code changes directly to the live local repo** (`~/Projects/Metaclip_Dev/Metaclip`). Code must go through GitHub feature branch → board-approved merge → `git pull`.
- **Never push code changes directly to `master`** without board approval.
- **Never sync or rebase directly from upstream** (`paperclipai/paperclip`). Monitor it; cherry-pick selectively.
- **Never start code implementation without commanding officer approval.** Ideacraft and research first, then ask.
- **Never build features for external customers.** Metacorp has no customers. Scope all work to internal needs.
- **Never restart the server autonomously.** A restart requires: a board-approved merge → `git pull` on the live instance → restart only if the change warrants it. See server restart rules below.

### Server Restart Authorization (CTO & Internal Affairs Lead Only)

The **CTO** and **Internal Affairs Lead** are authorized to restart the Metaclip server at `~/Projects/Metaclip_Dev/Metaclip`. A restart is only permitted after the following sequence for code changes:

1. A feature branch was created and tested on GitHub.
2. A board-approved merge to `master` has occurred.
3. `git pull origin master` has been run on the live local instance.
4. The nature of the change actually warrants a restart.

**Requirements when exercising this authority:**
1. Document the restart reason in the related issue comment.
2. Ensure no active runs are in progress that could be disrupted (check for blocking runs).
3. Link to the board-approved merge PR and Paperclip approval that justifies the restart.

Autonomous server restarts — without a board-approved merge in the chain — are **prohibited**.

Other engineering agents remain prohibited from restarting the server and must escalate to CTO or Internal Affairs Lead for restart requests.

## Development Workflow

### Code / Feature Changes
```
1. Identify a task or improvement idea
      ↓
2. Research / ideacraft (autonomous OK)
      ↓
3. Summarize findings → report to CTO
      ↓
4. CTO approves direction (required before coding)
      ↓
5. Create feature branch on GITHUB via API/gh CLI — NOT on local repo
      ↓
6. Make all commits via GitHub API/gh CLI — NOT by modifying ~/Projects/Metaclip_Dev/Metaclip
      ↓
7. Test on GitHub (PR, CI, review)
      ↓
8. Open PR → request board approval in Paperclip (merge_code type)
      ↓
9. Board approves → merge to master on GitHub
      ↓
10. CTO or Internal Affairs Lead: git pull origin master (on live local instance)
      ↓
11. Server restart ONLY if needed, ONLY by CTO or Internal Affairs Lead
```

### Governance / Rules Changes (AGENTS.md, instructions, process docs)
```
1. Edit files directly in ~/Projects/Metaclip_Dev/Metaclip
      ↓
2. Commit on a feature branch or master as appropriate
      ↓
3. No board approval required for instructions-only changes
```

## Commit Convention

Every commit you make must include the following co-author line at the end of the commit message:

```
Co-Authored-By: Paperclip <noreply@paperclip.ing>
```

## Merge Approval Flow

Before merging any feature branch to `master`, you must request board approval via a `merge_code` approval request.

### Step 1: Create the Approval

Use the Paperclip API to create a `merge_code` approval:

```bash
curl -X POST /api/companies/{companyId}/approvals \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "merge_code",
    "payload": {
      "title": "Brief description of the change",
      "branch": "feature/your-branch-name",
      "prUrl": "https://github.com/nrdnfjrdio/Metaclip/pull/123",
      "description": "What this PR does and why",
      "issueIds": ["META-XXX"]
    }
  }'
```

### Step 2: Link the Approval in Your PR

Include the approval ID in your PR description or comments so the board can review it.

### Step 3: Wait for Board Approval

The board will review the request and approve or deny via Paperclip. Monitor the approval status.

### Step 4: Merge After Approval

Only merge to `master` after receiving board approval. Do not force push or rebase after approval.

## Reporting Chain

- Engineering agents report to the **CTO**.
- The CTO reports to the **CEO (Steve)**.
- Board approval is required for any merge to `master`.

## Upstream Monitoring

The CTO runs a weekly routine to review https://github.com/paperclipai/paperclip for notable changes. If you identify something worth pulling in, file a task for the CTO with your assessment.

## Startup Bootstrap (Credential Fallback)

The `PAPERCLIP_API_KEY` environment variable may not be auto-injected by the `claude_local` adapter. Before performing any Paperclip API work, check whether it is present:

```bash
echo $PAPERCLIP_API_KEY
```

If it is empty or unset, obtain a short-lived key using the CLI — this must be done **before Step 1 of the heartbeat procedure**:

```bash
cd ~/Projects/Metaclip_Dev/Metaclip
npx paperclipai agent local-cli <your-agent-id> --company-id <company-id>
export PAPERCLIP_API_KEY=<printed key>
```

The `agent local-cli` command will print the export lines directly; copy and set `PAPERCLIP_API_KEY` before making any API calls.

## Comment and Description Discipline

- **Never write diagnostic output, debugging notes, or intermediate reasoning into the `description` field** of an issue. The `description` field is for a human-readable task description only.
- All status updates, blockers, diagnostics, and reasoning must be posted via `POST /api/issues/{issueId}/comments`.
- If you PATCH an issue with a `comment` field (inline comment on status change), that is acceptable — but the `description` field must remain a clean task description.
