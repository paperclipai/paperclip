---
name: "auto-skill-router"
description: "Automatically selects and loads the correct skill for every user request. Acts as the universal skill dispatcher — analyzes user intent, picks the best matching skill, reads its instructions, and executes using them. Triggers on all user requests before any other action."
key: "paperclipai/optional/agency-agents/auto-skill-router"
recommendedForRoles:
  - "generalist"
tags:
  - "agency-agents"
  - "generalist"
  - "auto"
  - "skill"
  - "router"
defaultInstall: false
---
# Auto Skill Router

## Purpose

Analyze every incoming user request, map it to the most appropriate skill, load that skill's full instructions via `read_file`, and execute using those instructions. The user never needs to name a skill explicitly — this router handles selection transparently.

---

## Execution Protocol

For every request, follow these steps in order:

1. **Classify** — Identify the user's primary intent using the routing table below.
2. **Select** — Choose the single best-matching skill (or up to 2 for compound requests).
3. **Announce** — State which skill was selected and why in one line before proceeding.
4. **Load** — Use `read_file` on the matched `SKILL.md` path(s).
5. **Execute** — Follow the loaded skill's instructions fully.

**Announce format:**
```
→ Routing to: [skill-name] — [one-sentence reason]
```

---

## Routing Table

### Ideation & Requirements

| User Intent / Keywords | Skill | SKILL.md Path |
|---|---|---|
| "I don't know what I want", "not sure", "help me think", "what should I build" | `interview-me` | `c:\Users\User\.agents\skills\interview-me\SKILL.md` |
| "brainstorm", "ideate", "refine idea", "stress-test my plan", "explore options", "variants" | `idea-refine` | `c:\Users\User\.agents\skills\idea-refine\SKILL.md` |
| "write a spec", "define requirements", "new feature", "new project", "what should we build" | `spec-driven-development` | `c:\Users\User\.agents\skills\spec-driven-development\SKILL.md` |
| "break this down", "plan tasks", "task list", "what are the steps", "estimate scope" | `planning-and-task-breakdown` | `c:\Users\User\.agents\skills\planning-and-task-breakdown\SKILL.md` |

### Implementation

| User Intent / Keywords | Skill | SKILL.md Path |
|---|---|---|
| "implement", "build", "create feature", "add functionality", "code this", "write code" | `incremental-implementation` | `c:\Users\User\.agents\skills\incremental-implementation\SKILL.md` |
| "build UI", "create component", "page layout", "responsive", "frontend", "React component", "Vue component" | `frontend-ui-engineering` | `c:\Users\User\.agents\skills\frontend-ui-engineering\SKILL.md` |
| "design API", "REST endpoint", "GraphQL", "interface contract", "module boundary", "API route" | `api-and-interface-design` | `c:\Users\User\.agents\skills\api-and-interface-design\SKILL.md` |
| "use official docs", "verify against documentation", "source-verified", "doc-grounded code" | `source-driven-development` | `c:\Users\User\.agents\skills\source-driven-development\SKILL.md` |
| "double-check this", "adversarial review", "verify my approach", "are we sure", "high stakes" | `doubt-driven-development` | `c:\Users\User\.agents\skills\doubt-driven-development\SKILL.md` |
| "missing context", "improve context", "setup rules", "configure agent", "copilot instructions" | `context-engineering` | `c:\Users\User\.agents\skills\context-engineering\SKILL.md` |

### Design & UI/UX

| User Intent / Keywords | Skill | SKILL.md Path |
|---|---|---|
| "beautiful UI", "production-quality interface", "color palette", "typography", "accessibility", "dark mode", "shadcn", "Tailwind styling" | `ui-styling` | `c:\Users\User\.agents\skills\ui-styling\SKILL.md` |
| "UI audit", "UX review", "interaction design", "visual hierarchy", "design critique", "GSAP animation", "chart type", "icon design" | `ui-ux-pro-max` | `c:\Users\User\.agents\skills\ui-ux-pro-max\SKILL.md` |
| "design tokens", "token architecture", "spacing scale", "component spec", "design system" | `design-system` | `c:\Users\User\.agents\skills\design-system\SKILL.md` |
| "logo", "brand identity", "corporate identity", "CIP", "icon set", "social media image", "mockup", "AI image" | `design` | `c:\Users\User\.agents\skills\design\SKILL.md` |
| "brand voice", "tone of voice", "messaging framework", "brand guidelines", "brand consistency" | `brand` | `c:\Users\User\.agents\skills\brand\SKILL.md` |
| "banner", "Facebook ad", "LinkedIn banner", "YouTube thumbnail", "hero image", "Google Display ad" | `banner-design` | `c:\Users\User\.agents\skills\banner-design\SKILL.md` |
| "presentation", "slides", "slide deck", "pitch deck", "create slides", "HTML presentation" | `slides` | `c:\Users\User\.agents\skills\slides\SKILL.md` |

### Testing & Quality

| User Intent / Keywords | Skill | SKILL.md Path |
|---|---|---|
| "write tests", "TDD", "unit test", "test coverage", "vitest", "jest", "pytest" | `test-driven-development` | `c:\Users\User\.agents\skills\test-driven-development\SKILL.md` |
| "test in browser", "Chrome DevTools", "DOM inspection", "network request", "visual test", "browser automation" | `browser-testing-with-devtools` | `c:\Users\User\.agents\skills\browser-testing-with-devtools\SKILL.md` |
| "review this code", "code review", "PR review", "check for bugs", "review before merge" | `code-review-and-quality` | `c:\Users\User\.agents\skills\code-review-and-quality\SKILL.md` |
| "too complex", "hard to read", "simplify", "refactor for clarity", "clean this up" | `code-simplification` | `c:\Users\User\.agents\skills\code-simplification\SKILL.md` |
| "security", "vulnerability", "OWASP", "injection", "auth hardening", "sanitize input", "secure this" | `security-and-hardening` | `c:\Users\User\.agents\skills\security-and-hardening\SKILL.md` |
| "slow", "performance", "optimize", "Core Web Vitals", "profiling", "latency", "bundle size" | `performance-optimization` | `c:\Users\User\.agents\skills\performance-optimization\SKILL.md` |

### Debugging & Errors

| User Intent / Keywords | Skill | SKILL.md Path |
|---|---|---|
| "broken", "bug", "error", "not working", "wrong output", "crash", "exception", "debug", "fix this" | `debugging-and-error-recovery` | `c:\Users\User\.agents\skills\debugging-and-error-recovery\SKILL.md` |

### Observability & Operations

| User Intent / Keywords | Skill | SKILL.md Path |
|---|---|---|
| "add logging", "metrics", "tracing", "alerts", "monitoring", "observable", "diagnose production" | `observability-and-instrumentation` | `c:\Users\User\.agents\skills\observability-and-instrumentation\SKILL.md` |
| "CI/CD", "pipeline", "GitHub Actions", "deploy automatically", "build automation", "quality gate" | `ci-cd-and-automation` | `c:\Users\User\.agents\skills\ci-cd-and-automation\SKILL.md` |
| "deploy", "launch", "ship to production", "pre-launch checklist", "rollout", "rollback strategy" | `shipping-and-launch` | `c:\Users\User\.agents\skills\shipping-and-launch\SKILL.md` |

### Codebase Evolution

| User Intent / Keywords | Skill | SKILL.md Path |
|---|---|---|
| "commit", "git", "branch", "merge", "PR", "semantic version", "changelog", "tag release" | `git-workflow-and-versioning` | `c:\Users\User\.agents\skills\git-workflow-and-versioning\SKILL.md` |
| "deprecate", "migrate", "remove old", "sunset", "upgrade from", "breaking change" | `deprecation-and-migration` | `c:\Users\User\.agents\skills\deprecation-and-migration\SKILL.md` |
| "write docs", "ADR", "architecture decision", "document this", "README", "API docs" | `documentation-and-adrs` | `c:\Users\User\.agents\skills\documentation-and-adrs\SKILL.md` |

### Meta

| User Intent / Keywords | Skill | SKILL.md Path |
|---|---|---|
| "find a skill", "is there a skill for", "install a skill", "skill for X", "can you do X" | `find-skills` | `c:\Users\User\.agents\skills\find-skills\SKILL.md` |
| "which skill applies", "what skill should I use", "discover skills" | `using-agent-skills` | `c:\Users\User\.agents\skills\using-agent-skills\SKILL.md` |

---

## Compound Requests

When a request spans two intents (e.g., "build and review" or "plan and implement"), load **both** skills sequentially:

```
→ Routing to: planning-and-task-breakdown + incremental-implementation
   Planning first, then implementation.
```

Load and execute the planning skill first, confirm with the user, then load and execute the implementation skill.

---

## Ambiguity Resolution

When multiple skills could match, apply this priority order:

1. **Most specific** wins over general (e.g., `banner-design` beats `design` for banner requests)
2. **Current phase** wins (e.g., if spec exists → `incremental-implementation`; if not → `spec-driven-development`)
3. **User's verb** is the strongest signal — "review", "debug", "build", "design", "deploy" are anchors
4. **Ask once** if still ambiguous — present the top 2 options and let the user pick

---

## Fallback

If no skill matches with confidence ≥ 70%:

1. Proceed using general knowledge
2. Note at the end: `Note: No specific skill matched. Consider running 'npx skills find [topic]' to install one.`

---

## Skill Paths Reference

All skills are available at two root locations:

- **Global:** `c:\Users\User\.agents\skills\[skill-name]\SKILL.md`
- **Workspace:** `c:\Users\User\Desktop\HoraStaycation\.agents\skills\[skill-name]\SKILL.md`

Prefer the global path. Fall back to workspace path if the skill only exists there.
