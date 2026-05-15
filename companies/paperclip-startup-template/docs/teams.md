# Teams

This document defines the org chart, reporting lines, and default skill bundles for every role in a company spun up from the Paperclip Startup Template.

## 1. Org chart

```
                            CEO
                           /   \
                         CTO    CMO
                       /  |  \
                     FE   BE  Coder
                          |
                         QA  ←  (reports through CTO; pairs with engineers)
                          |
                  SecurityEngineer  ← (reports through CTO; reviews security-sensitive PRs)
```

## 2. Reporting lines (verbatim for `reportsTo` in agentcompanies/v1 frontmatter)

| Role | Slug | reportsTo |
|---|---|---|
| CEO | `ceo` | `null` |
| CTO | `cto` | `ceo` |
| CMO | `cmo` | `ceo` |
| FrontendEngineer | `frontendengineer` | `cto` |
| BackendEngineer | `backendengineer` | `cto` |
| Coder | `coder` | `cto` |
| QA | `qa` | `cto` |
| SecurityEngineer | `securityengineer` | `cto` |

## 3. Role definitions (one-sentence)

- **CEO** — strategy, prioritisation, cross-functional coordination, board interface, hiring approvals; delegates everything else.
- **CTO** — technical direction, architecture decisions, plan authorship, engineering coordination; does **not** cut code (rule §4 in [RULES.md](../RULES.md)).
- **CMO** — marketing, content, growth, devrel, brand voice.
- **FrontendEngineer** — UI, components, client state, browser routing, design-system implementation. Does **not** touch backend code.
- **BackendEngineer** — HTTP/RPC handlers, services, persistence, background jobs, observability, infra. Does **not** touch frontend code.
- **Coder** — generalist engineer for tasks that span lanes or don't fit cleanly into FE/BE; follows the full issue → plan → implement → commit → PR lifecycle.
- **QA** — reproducible test plans, user-visible verification, browser testing, regression coverage. Owns the final "done" verdict on user-facing changes.
- **SecurityEngineer** — auth, crypto, secrets, permissions, adapter/tool access, security review of PRs touching those areas.

## 4. `desiredSkills` bundles per role

Used by `paperclip-create-agent` when hiring into a new company spun up from this template.

| Role | Default `desiredSkills` |
|---|---|
| CEO | `paperclip`, `para-memory-files` |
| CTO | `paperclip`, `paperclip-converting-plans-to-tasks`, `paperclip-create-agent` |
| CMO | `paperclip` |
| FrontendEngineer | `paperclip`, `paperclip-classify-issue`, `paperclip-plan-from-issue`, `paperclip-implement-plan`, `paperclip-branch-name`, `paperclip-commit-message`, `paperclip-pr-from-branch`, `progress-comment-template` |
| BackendEngineer | `paperclip`, `paperclip-classify-issue`, `paperclip-plan-from-issue`, `paperclip-implement-plan`, `paperclip-branch-name`, `paperclip-commit-message`, `paperclip-pr-from-branch`, `progress-comment-template` |
| Coder | `paperclip`, `paperclip-classify-issue`, `paperclip-plan-from-issue`, `paperclip-implement-plan`, `paperclip-branch-name`, `paperclip-commit-message`, `paperclip-pr-from-branch`, `progress-comment-template` |
| QA | `paperclip`, `progress-comment-template` |
| SecurityEngineer | `paperclip`, `progress-comment-template`, `security-review` |

These are starter bundles; companies can add to them after hire using the company skills API.

## 5. Hand-off pattern

- **Board → CEO:** strategy, prioritisation, approvals.
- **CEO → CTO:** all technical work (code, bugs, features, infra, devtools).
- **CEO → CMO:** all marketing / content / growth.
- **CTO → engineers:** scoped child issues with `parentId` set. Engineer picks lane (FE / BE / Coder).
- **Engineer → QA:** user-visible change → QA verifies → QA marks `done` or kicks back.
- **Engineer → SecurityEngineer:** security-sensitive change → Security reviews → Security clears.
- **Anyone → CEO:** escalation only, via CTO. CEO never receives direct comments from non-executives.
