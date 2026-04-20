# Company Improvement Verification Checklist

Use this checklist for changes that improve a Paperclip company, company package,
agent instructions, project setup, routine, or operating process. Not every item
applies to every change; mark irrelevant checks as `N/A` instead of silently
skipping them.

## 1. Scope

- [ ] Source issue or project is named.
- [ ] Original acceptance criteria are copied or summarized before testing.
- [ ] Affected company, project, agents, skills, and documents are identified.
- [ ] Verification environment is named: repo path, Paperclip URL, company prefix,
  browser/API client, and any relevant adapter runtime.
- [ ] Any assumptions, unavailable credentials, or intentionally skipped paths are
  recorded before the final recommendation.

## 2. UI Checks

- [ ] The company switcher or URL prefix shows the expected company.
- [ ] The dashboard, issue, project, agent, approval, or routine page reflects the
  change in the correct company only.
- [ ] Primary workflows complete without silent failures; user-visible errors are
  clear when an operation cannot proceed.
- [ ] Links, previews, attachments, documents, and output artifacts open from the UI.
- [ ] Issue detail shows the expected status, assignee, checklist, links, blockers,
  comments, run information, and project/goal context.
- [ ] If the change affects layout or interaction, check at least one desktop width
  and one narrow/mobile width.

## 3. API And Data Checks

- [ ] API reads and writes are company-scoped and use the expected company ID.
- [ ] Agent calls use bearer credentials for the agent's company and cannot access
  another company.
- [ ] Mutations preserve Paperclip invariants: single assignee, atomic checkout,
  status transition rules, blocker semantics, approval gates, and budget
  hard-stops.
- [ ] Mutating actions create activity or audit evidence where the product expects
  it.
- [ ] Returned objects include the fields the UI or agent runtime depends on, with
  sensitive values redacted.
- [ ] Database or exported package changes do not introduce cross-company IDs,
  hardcoded local paths, raw secrets, or stale adapter assumptions.

## 4. Agent Instructions And Runtime Checks

- [ ] Relevant `AGENTS.md`, skill, project, and routine instructions are present at
  the paths referenced by the agent or package.
- [ ] Relative file references resolve from the documented base directory.
- [ ] Wake payload handling is clear: latest comments are acknowledged first, scoped
  wakes do not pick unrelated work, and already-claimed issues are not checked
  out again.
- [ ] Agent output is durable: important decisions, blockers, verification notes, or
  handoffs are written to the issue, issue document, or package file instead of
  only to transient run logs.
- [ ] Cadence guidance is respected: normal priority work stays focused and
  token-conscious; faster work is reserved for critical or explicitly urgent
  requests.
- [ ] If adapter configuration changed, the adapter can be loaded without core code
  imports for external-only adapters.

## 5. Issue And Project State Checks

- [ ] Source issue status matches reality: `done` only when no follow-up remains,
  `blocked` only with a specific blocker and owner, and `in_review` only when
  review is actually pending.
- [ ] Checklist items, issue links, documents, attachments, and child issues are
  used when they make the work inspectable.
- [ ] Follow-up issues have the correct parent, goal, company, assignee, priority,
  billing code, workspace inheritance, and blocker links.
- [ ] Comments include what passed, what failed, what was not run, and the next
  owner for any unresolved work.
- [ ] Ticket references in issue comments are clickable company-prefixed links.

## 6. Docs Checks

- [ ] Operational instructions affected by the change are updated in the repo,
  company package, agent instructions, or issue document.
- [ ] Commands, ports, paths, environment variables, and URLs are current for the
  documented workflow.
- [ ] New docs explain how to repeat the workflow, not just what changed.
- [ ] Known fork-specific or deployment-specific behavior is labeled as such.
- [ ] Strategic docs are updated only when behavior or product contract changed;
  otherwise prefer focused operational notes.

## 7. Verification Note Template

```md
Verification for [ISSUE-LINK]

Acceptance criteria checked:
- ...

Passed:
- UI: ...
- API/data: ...
- Agent instructions/runtime: ...
- Issue/project state: ...
- Docs: ...

Failed:
- ...

Not run / N/A:
- ...

Risk and recommendation:
- ...

Follow-up owner:
- ...
```

## 8. Handoff Rules

- Failed behavior goes back to the Paperclip Systems Engineer with exact
  reproduction steps, expected result, actual result, environment, and evidence.
- Docs or process gaps go to the Product and Agent Experience Lead with the
  affected workflow and proposed doc location.
- Release risk goes to the Steward with severity, affected company or product
  surface, workaround, and a clear ship or hold recommendation.
