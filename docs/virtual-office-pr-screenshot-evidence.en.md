# Virtual Office PR Screenshot Evidence

Use this file before opening a Virtual Office PR. Because Virtual Office is a visual workbench, reviewers should see a small screenshot set that explains the value quickly.

Screenshots are PR evidence only. They are not authorization to install Hermes, press Run now, enable schedule triggers, enable the heartbeat scheduler, or wake a local model.

## Capture Local Screenshots

First confirm the preview is available:

```powershell
pnpm run office:check
```

Then capture screenshots:

```powershell
pnpm run office:pr-screenshots
```

Output:

```text
.paperclip-local/virtual-office-pr-screenshots/
```

This directory is ignored by git. After screenshots are generated, review them manually for private data before attaching any image to a public GitHub PR.

## Suggested Screenshot Set

Prepare at least these views:

1. Office workbench
   - 2.5D office
   - Employees, skills, projects, workflow, or checklist summary
2. Safety status or checklist
   - Shows no active run
   - Shows Sandbox/Test or explicit-authorization boundaries
3. Employee and skill management
   - Shows how beginners understand agents and skills visually
4. Project / issue / workflow view
   - Shows workflow, owners, upstream/downstream work, or parallel work
5. Routine / schedule safety view
   - Shows schedules do not silently activate without authorization

If you attach only one image, choose the Office workbench.

## Do Not Attach

Screenshots must not show:

- API keys, tokens, passwords, or a full `.env`
- Private repository URLs, internal URLs, or full logs
- Production customer data, production trading data, or unauthorized data
- Employee names, task contents, or discussion records that should not be public
- Any view that looks like active runs, Run now, schedule triggers, or heartbeat scheduler are enabled, unless the PR is explicitly fixing that bug

## Pre-PR Review

1. The image shows Virtual Office, not a black page, Loading state, or error page.
2. The image is not only the app shell or a loading skeleton; if it only shows empty cards, do not attach it to the PR.
3. The image communicates the core value of this PR.
4. The image contains no private data.
5. The PR text still keeps the safety stop lines.
6. If screenshots come from local data, the PR says they are local preview evidence, not production data.

## Suggested PR Text

```markdown
Screenshots:

- Office workbench: shows the 2.5D office, agents, skills, projects, and workflow summary.
- Safety/checklist view: shows the no-active-run and explicit-authorization boundaries.

The screenshots were captured from a local preview. They do not include secrets, production data, Run now, schedule trigger, heartbeat scheduler, or local-model wake-up evidence.
```
