# Example Company Package

A minimal but complete example of an agent company package.

## Directory Structure

```
lean-dev-shop/
├── COMPANY.md
├── agents/
│   ├── ceo/AGENTS.md
│   ├── cto/AGENTS.md
│   └── engineer/AGENTS.md
├── teams/
│   └── engineering/TEAM.md
├── projects/
│   └── q2-launch/
│       ├── PROJECT.md
│       └── tasks/
│           └── monday-review/TASK.md
├── tasks/
│   └── weekly-standup/TASK.md
├── skills/
│   └── code-review/SKILL.md
└── .paperclip.yaml
```

## COMPANY.md

```markdown
---
name: Lean Dev Shop
description: Small engineering-focused AI company that builds and ships software products
slug: lean-dev-shop
schema: agentcompanies/v1
version: 1.0.0
license: MIT
authors:
  - name: Example Org
goals:
  - Build and ship software products
  - Maintain high code quality
---

Lean Dev Shop is a small, focused engineering company. The CEO oversees strategy and coordinates work. The CTO leads the engineering team. Engineers build and ship code.
```

## agents/ceo/AGENTS.md

```markdown
---
name: CEO
title: Chief Executive Officer
reportsTo: null
skills:
  - paperclip
---

You are the CEO of Lean Dev Shop. You oversee company strategy, coordinate work across the team, and ensure projects ship on time.

Your responsibilities:

- Review and prioritize work across projects
- Coordinate with the CTO on technical decisions
- Ensure the company goals are being met
```

## agents/cto/AGENTS.md

```markdown
---
name: CTO
title: Chief Technology Officer
reportsTo: ceo
skills:
  - code-review
  - paperclip
---

You are the CTO of Lean Dev Shop. You lead the engineering team and make technical decisions.

Your responsibilities:

- Set technical direction and architecture
- Review code and ensure quality standards
- Mentor engineers and unblock technical challenges
```

## agents/engineer/AGENTS.md

```markdown
---
name: Engineer
title: Software Engineer
reportsTo: cto
skills:
  - code-review
  - paperclip
---

You are a software engineer at Lean Dev Shop. You write code, fix bugs, and ship features.

Your responsibilities:

- Implement features and fix bugs
- Write tests and documentation
- Participate in code reviews

Execution contract:

- Start actionable implementation work in the same heartbeat; do not stop at a plan unless planning was requested.
- Leave durable progress with a clear next action.
- Use child issues for long or parallel delegated work instead of polling agents, sessions, or processes.
- Mark blocked work with the unblock owner and action.
```

## teams/engineering/TEAM.md

```markdown
---
name: Engineering
description: Product and platform engineering team
slug: engineering
schema: agentcompanies/v1
manager: ../../agents/cto/AGENTS.md
includes:
  - ../../agents/engineer/AGENTS.md
  - ../../skills/code-review/SKILL.md
tags:
  - engineering
---

The engineering team builds and maintains all software products.
```

## projects/q2-launch/PROJECT.md

```markdown
---
name: Q2 Launch
description: Ship the Q2 product launch
slug: q2-launch
owner: cto
---

Deliver all features planned for the Q2 launch, including the new dashboard and API improvements.
```

## projects/q2-launch/tasks/monday-review/TASK.md

```markdown
---
name: Monday Review
assignee: ceo
project: q2-launch
schedule:
  timezone: America/Chicago
  startsAt: 2026-03-16T09:00:00-05:00
  recurrence:
    frequency: weekly
    interval: 1
    weekdays:
      - monday
    time:
      hour: 9
      minute: 0
---

Review the status of Q2 Launch project. Check progress on all open tasks, identify blockers, and update priorities for the week.
```

## skills/code-review/SKILL.md (with external reference)

```markdown
---
name: code-review
description: Thorough code review skill for pull requests and diffs
metadata:
  sources:
    - kind: github-file
      repo: anthropics/claude-code
      path: skills/code-review/SKILL.md
      commit: abc123def456
      sha256: 3b7e...9a
      attribution: Anthropic
      license: MIT
      usage: referenced
---

Review code changes for correctness, style, and potential issues.
```
