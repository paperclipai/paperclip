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

> **The local install is the live running instance of Metaclip. Never commit directly to `master` or make untracked edits outside of the feature-branch workflow.**

### Important: Watch Mode and Live Reload

The Metaclip dev server runs in **watch mode** from `~/Projects/Metaclip_Dev/Metaclip`. This means:

- **Any file change in the repo directory is immediately reflected in the running server** — including changes on feature branches, before any merge or PR.
- This is expected dev-environment behavior. It does NOT mean you are bypassing governance.
- The governance rules protect `master` (the canonical branch) and require board approval for merges. They do not prevent feature-branch changes from being hot-reloaded locally.
- Agents should understand that stakeholders will see feature-branch work in the live UI as soon as files are written, even before a PR is raised. Keep experimental branches clearly named and document their status in comments.

## Governance Rules

### What you MUST do

1. **Develop on feature branches only.** Never commit directly to `master`. Always create a new branch for your work:
   ```
   git checkout -b feature/<short-description>
   ```

2. **Get board approval before merging.** All merges to `master` require explicit approval from the board via a Paperclip approval request. Raise a PR and link the approval before merging.

3. **Cherry-pick intentionally from upstream.** Monitor https://github.com/paperclipai/paperclip for useful changes, but never run a full sync or rebase from upstream. Review changes first, then selectively apply what is relevant.

4. **Coordinate with your commanding officer before implementing.** You may research and ideacraft freely, but must get sign-off from the CTO (or the CEO for cross-cutting concerns) before beginning implementation work.

### What you must NEVER do

- **Never push directly to `master`** without board approval.
- **Never sync or rebase directly from upstream** (`paperclipai/paperclip`). Monitor it; cherry-pick selectively.
- **Never commit directly to `master`** in the local repo at `~/Projects/Metaclip_Dev/Metaclip`. All changes must go through a feature branch and the PR/approval process.
- **Never start implementation without commanding officer approval.** Ideacraft and research first, then ask.
- **Never build features for external customers.** Metacorp has no customers. Scope all work to internal needs.

### Server Restart Authorization (CTO & Internal Affairs Lead Only)

The **CTO** and **Internal Affairs Lead** are authorized to restart the Metaclip server at `~/Projects/Metaclip_Dev/Metaclip` for operational purposes. This includes:

- Deploying critical fixes that require server restart
- Resolving operational issues blocking health checks or routine executions
- Applying environment configuration changes

**Requirements when exercising this authority:**
1. Document the restart reason in the related issue comment
2. Ensure no active runs are in progress that could be disrupted (check for blocking runs)
3. Link to the approval or task that justifies the restart

Other engineering agents remain prohibited from restarting the server and must escalate to CTO or Internal Affairs Lead for restart requests.

## Development Workflow

```
1. Identify a task or improvement idea
      ↓
2. Research / ideacraft (autonomous OK)
      ↓
3. Summarize findings → report to CTO
      ↓
4. CTO approves direction (required before coding)
      ↓
5. Create feature branch: git checkout -b feature/<name>
      ↓
6. Develop & test on branch
      ↓
7. Open PR → request board approval in Paperclip
      ↓
8. Board approves → merge to master
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
