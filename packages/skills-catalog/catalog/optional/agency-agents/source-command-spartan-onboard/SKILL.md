---
name: "source-command-spartan-onboard"
description: "Understand a new codebase — scan, map architecture, set up rules, and get ready to build"
key: "paperclipai/optional/agency-agents/source-command-spartan-onboard"
recommendedForRoles:
  - "engineer"
  - "designer"
tags:
  - "agency-agents"
  - "engineer"
  - "designer"
  - "source"
  - "command"
  - "spartan"
  - "onboard"
defaultInstall: false
---
# source-command-spartan-onboard

Use this skill when the user asks to run the migrated source command `spartan-onboard`.

## Command Template

# Onboard to This Codebase

You are the **Onboard workflow leader** — go from "I just joined" to "I'm ready to build."

You handle scanning, mapping, and setup in one flow. Don't tell the user to run separate commands.

```
PIPELINE:

  Check Context → Scan → Map → Setup → Save to Memory
       │            │       │      │          │
   .memory/      Gate 1  Gate 2  Gate 3    auto-save
   prior sessions
```

---

## Step 0: Check Context (silent)

Before scanning from scratch, check if someone already did this work.

```bash
# Check for existing memory/knowledge
ls .memory/index.md .memory/knowledge/ 2>/dev/null

# Check for existing AGENTS.md
ls AGENTS.md 2>/dev/null

# Check for prior onboarding
ls .handoff/*.md 2>/dev/null
```

**If `.memory/` has knowledge files**, read them. Someone already captured context:
> "Found existing project knowledge in `.memory/`. Reading it before scanning."

**If AGENTS.md exists**, read it first. Build on top of it, don't start over.

---

## Stage 1: Scan

**Goal:** Understand what this project is at a surface level.

### Check project basics
```bash
# What's in the root?
ls -la

# Package/build files
ls build.gradle.kts settings.gradle.kts pom.xml 2>/dev/null
ls package.json tsconfig.json next.config.* 2>/dev/null
ls Dockerfile docker-compose.yml 2>/dev/null
ls Makefile 2>/dev/null

# Existing docs
ls AGENTS.md README.md CONTRIBUTING.md 2>/dev/null
ls .planning/ .memory/ .handoff/ 2>/dev/null

# Git info
git log --oneline -20
git shortlog -sn --no-merges | head -10
git branch -a | head -20
```

### Classify the project

| Signal | Meaning |
|--------|---------|
| `build.gradle.kts` + `src/main/kotlin/` | Kotlin/Micronaut backend |
| `package.json` + `next.config.*` | Next.js/React frontend |
| Both | Full-stack monorepo |
| `docker-compose.yml` with multiple services | Microservices |
| Already has `AGENTS.md` | Someone set this up before — read it |
| Has `.planning/` | Has saved specs/plans — check `.planning/specs/` and `.planning/plans/` |

### Produce a quick summary

```markdown
## Project Scan

**Name:** [from package.json, settings.gradle, or folder name]
**Stack:** [what you detected]
**Size:** [file count, line count estimate]
**Team:** [from git shortlog — who contributes most]
**Activity:** [last commit date, commit frequency]
**Existing docs:** [what exists already]
**Tests:** [test framework, rough coverage indicator]
```

**GATE 1 — STOP and ask:**
> "Here's what I see: [summary]. Does this match your understanding? Anything I should know that's not in the code?"

---

## Stage 2: Map

**Goal:** Understand how the pieces fit together. Build a mental model.

### Agent Teams boost (if enabled)

```bash
echo "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-not_set}"
```

**If Agent Teams is enabled AND the codebase is large (50+ files or multi-module):**

Run a parallel mapping team for faster analysis:

```
TeamCreate(team_name: "onboard-{project-slug}", description: "Mapping codebase for onboarding")

TaskCreate(subject: "Map tech stack", description: "Languages, frameworks, dependencies, build tools, runtime")
TaskCreate(subject: "Map architecture", description: "Patterns, layers, data flow, entry points, error handling")
TaskCreate(subject: "Map quality", description: "Conventions, test patterns, code quality concerns")

Agent(
  team_name: "onboard-{project-slug}",
  name: "stack-mapper",
  subagent_type: "Explore",
  prompt: "Map the tech stack: languages, frameworks, dependencies, build tools, runtime.
    Write findings as structured markdown. Check TaskList, claim your task."
)

Agent(
  team_name: "onboard-{project-slug}",
  name: "arch-mapper",
  subagent_type: "Explore",
  prompt: "Map architecture: patterns, layers, data flow, entry points, error handling.
    Trace one typical request end-to-end. Check TaskList, claim your task."
)

Agent(
  team_name: "onboard-{project-slug}",
  name: "quality-mapper",
  subagent_type: "Explore",
  prompt: "Map conventions, test patterns, code quality concerns. Find TODOs, tech debt.
    Check TaskList, claim your task."
)
```

After all teammates report back, synthesize into the architecture overview below, then `TeamDelete()`.

**If Agent Teams is NOT enabled (or codebase is small)**, map manually:

### Architecture mapping

- Identify the main modules/packages
- Trace a request from entry point to response (for backends) or from page load to render (for frontends)
- Find the data model (entities, schemas, types)
- Identify external dependencies (databases, APIs, message queues)

### For backend projects
```
Request flow:
  Client → Controller → Manager/Service → Repository → Database
                     ↘ External APIs (if any)

Key directories:
  controllers/   — HTTP endpoints
  managers/      — Business logic
  repositories/  — Data access
  models/        — Entities + DTOs
  config/        — Application config
```

### For frontend projects
```
Render flow:
  Route → Page → Layout → Components → Hooks → API client → Backend

Key directories:
  app/           — Pages and routes
  components/    — Reusable UI
  hooks/         — Custom hooks
  lib/           — Utilities and API client
  types/         — TypeScript types
```

### Produce an architecture overview

```markdown
## Architecture

**Pattern:** [MVC, layered, microservices, etc.]
**Entry points:** [main files, route handlers]
**Data model:** [key entities and their relationships]
**External deps:** [databases, APIs, queues, caches]
**Config:** [how config works — env vars, files, etc.]

**Request flow:**
[trace one typical request end-to-end]

**Key decisions:**
[any non-obvious architecture choices — why things are the way they are]
```

### Check for gotchas
- Any code that looks unused but might be important?
- Unusual patterns that a new dev would trip on?
- Known tech debt? (look for TODO comments, fixme markers)

```bash
grep -rn "TODO\|FIXME\|HACK\|XXX" --include="*.kt" --include="*.tsx" --include="*.ts" src/ | head -20
```

**GATE 2 — STOP and ask:**
> "Here's how this project works: [architecture overview]. Questions before I set things up?"
>
> This is the most important gate. Make sure the user's mental model matches reality.

---

## Stage 3: Setup

**Goal:** Configure the AI tools for this specific project.

### Generate or update AGENTS.md
Use the approach from `/spartan:init-project` internally:
- Tech stack section
- Architecture section (from Stage 2)
- Conventions (detected from code patterns)
- Key commands (build, test, run)
- Domain context

If AGENTS.md already exists, don't overwrite — merge your findings into it.

### Recommend packs
Based on the detected stack:

| Stack detected | Recommended packs |
|----------------|-------------------|
| Kotlin/Micronaut | `core` + `backend-micronaut` (pulls in `database` + `shared-backend`) |
| Next.js/React | `core` + `frontend-react` |
| Full-stack | `core` + `backend-micronaut` + `frontend-react` |
| Unknown | `core` only, ask about stack |

If packs aren't installed yet:
> "This is a [stack] project. I'd add the [pack] pack for stack-specific guidance. Want me to set it up?"

### Verify setup
```bash
# Check AGENTS.md exists and has content
ls -la AGENTS.md
wc -l AGENTS.md

# Check if rules are in place
ls ~/.Codex/rules/ 2>/dev/null
```

---

## Stage 4: Save to Memory (auto-runs)

After setup, save key findings so future sessions don't have to re-scan.

```bash
mkdir -p .memory/knowledge .memory/decisions
```

**What to save:**
- **Architecture summary** → `.memory/knowledge/architecture.md`
- **Key gotchas/patterns found** → `.memory/knowledge/gotchas.md`
- **Tech debt notes** → `.memory/knowledge/tech-debt.md` (if significant)
- **Non-obvious decisions** → `.memory/decisions/` (only if the user shared context that isn't in the code)

**What NOT to save:**
- Things already in AGENTS.md (don't duplicate)
- Obvious stuff (it's a React app, it uses TypeScript)
- File paths (they change)

Create or update `.memory/index.md`:
```markdown
# Project Memory

## Knowledge
- [architecture.md](knowledge/architecture.md) — [one-line summary]
- [gotchas.md](knowledge/gotchas.md) — [one-line summary]

## Decisions
[add any decisions the user shared]
```

**GATE 3 — Done.**
> "You're set up. Here's what's ready:
> - AGENTS.md: [created/updated]
> - Stack: [detected stack]
> - Packs: [what's installed]
> - Memory: key findings saved for future sessions
>
> Start building with `/spartan:build [feature]` or explore with `/spartan` anytime."

---

## If the codebase is legacy / brownfield

If the scan reveals a messy or unfamiliar codebase (no docs, no tests, tangled dependencies), use the approach from `/spartan:brownfield` internally for a deeper analysis before mapping.

Signs of brownfield:
- No tests or very few tests
- No documentation
- Multiple frameworks or patterns mixed together
- Large files (1000+ lines)
- Circular dependencies

In this case, add a warning:
> "This codebase has some legacy patterns. Here's what to watch out for: [specific issues]. I'd suggest adding tests before making changes in [risky areas]."

---

## Rules

- **Don't change any code during onboarding.** This is read-only. Understand first.
- **Ask about what's NOT in the code.** Business context, deployment process, team conventions — things you can't see in files.
- **Don't assume conventions from one file apply everywhere.** Check multiple files for consistency.
- **If AGENTS.md exists, read it before scanning.** Someone already did this work — build on it.
- **Save findings to memory.** Future sessions should benefit from this onboarding work.
- **The architecture overview should fit on one screen.** If it's longer, you're over-explaining.
