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

> **The local install is the live running instance of Metaclip. Never modify it directly.**

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
- **Never modify the running Metaclip instance** at `~/Projects/Metaclip_Dev/Metaclip`. It is the live environment — treat it as read-only.
- **Never start implementation without commanding officer approval.** Ideacraft and research first, then ask.
- **Never build features for external customers.** Metacorp has no customers. Scope all work to internal needs.

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

## Reporting Chain

- Engineering agents report to the **CTO**.
- The CTO reports to the **CEO (Steve)**.
- Board approval is required for any merge to `master`.

## Upstream Monitoring

The CTO runs a weekly routine to review https://github.com/paperclipai/paperclip for notable changes. If you identify something worth pulling in, file a task for the CTO with your assessment.
