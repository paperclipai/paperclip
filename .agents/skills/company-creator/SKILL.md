---
name: company-creator
description: >
  Create agent company packages conforming to the Agent Companies specification
  (agentcompanies/v1). Use when a user wants to create a new agent company from
  scratch, build a company around an existing git repo or skills collection, or
  scaffold a team/department of agents. Triggers on: "create a company", "make me
  a company", "build a company from this repo", "set up an agent company",
  "create a team of agents", "hire some agents", or when given a repo URL and
  asked to turn it into a company. Do NOT use for importing an existing company
  package (use the CLI import command instead) or for modifying a company that
  is already running in Paperclip.
---

# Company Creator

Create agent company packages that conform to the Agent Companies specification.

Spec references:

- Normative spec: `docs/companies/companies-spec.md` (read this before generating files)
- Web spec: https://agentcompanies.io/specification
- Protocol site: https://agentcompanies.io/

## Two Modes

### Mode 1: Company From Scratch

The user describes what they want. Interview them to flesh out the vision, then generate the package.

### Mode 2: Company From a Repo

The user provides a git repo URL, local path, or tweet. Analyze the repo, then create a company that wraps it.

See [references/from-repo-guide.md](references/from-repo-guide.md) for detailed repo analysis steps.

## Process

### Step 1: Gather Context

Determine which mode applies:

- **From scratch**: What kind of company or team? What domain? What should the agents do?
- **From repo**: Clone/read the repo. Scan for existing skills, agent configs, README, source structure.

### Step 2: Interview (Use AskUserQuestion)

Do not skip this step. Use AskUserQuestion to align with the user before writing any files.

**For from-scratch companies**, ask about:

- Company purpose and domain (1-2 sentences is fine)
- What agents they need - propose a hiring plan based on what they described
- Whether this is a full company (needs a CEO) or a team/department (no CEO required)
- Any specific skills the agents should have
- How work flows through the organization (see "Workflow" below)
- Whether they want projects and starter tasks

**For from-repo companies**, present your analysis and ask:

- Confirm the agents you plan to create and their roles
- Whether to reference or vendor any discovered skills (default: reference)
- Any additional agents or skills beyond what the repo provides
- Company name and any customization
- Confirm the workflow you inferred from the repo (see "Workflow" below)

**Workflow — how does work move through this company?**

A company is not just a list of agents with skills. It's an organization that takes ideas and turns them into work products. You need to understand the workflow so each agent knows:

- Who gives them work and in what form (a task, a branch, a question, a review request)
- What they do with it
- Who they hand off to when they're done, and what that handoff looks like
- What "done" means for their role

**Not every company is a pipeline.** Infer the right workflow pattern from context:

- **Pipeline** — sequential stages, each agent hands off to the next. Use when the repo/domain has a clear linear process (e.g. plan → build → review → ship → QA, or content ideation → draft → edit → publish).
- **Hub-and-spoke** — a manager delegates to specialists who report back independently. Use when agents do different kinds of work that don't feed into each other (e.g. a CEO who dispatches to a researcher, a marketer, and an analyst).
- **Collaborative** — agents work together on the same things as peers. Use for small teams where everyone contributes to the same output (e.g. a design studio, a brainstorming team).
- **On-demand** — agents are summoned as needed with no fixed flow. Use when agents are more like a toolbox of specialists the user calls directly.

For from-scratch companies, propose a workflow pattern based on what they described and ask if it fits.

For from-repo companies, infer the pattern from the repo's structure. If skills have a clear sequential dependency (like `plan-ceo-review → plan-eng-review → review → ship → qa`), that's a pipeline. If skills are independent capabilities, it's more likely hub-and-spoke or on-demand. State your inference in the interview so the user can confirm or adjust.

**Key interviewing principles:**

- Propose a concrete hiring plan. Don't ask open-ended "what agents do you want?" - suggest specific agents based on context and let the user adjust.
- Keep it lean. Most users are new to agent companies. A few agents (3-5) is typical for a startup. Don't suggest 10+ agents unless the scope demands it.
- From-scratch companies should start with a CEO who manages everyone. Teams/departments don't need one.
- Ask 2-3 focused questions per round, not 10.

### Step 3: Read the Spec

Before generating any files, read the normative spec:

```
docs/companies/companies-spec.md
```

Also read the quick reference: [references/companies-spec.md](references/companies-spec.md)

And the example: [references/example-company.md](references/example-company.md)

### Step 4: Generate the Package

Create the directory structure and all files. Follow the spec's conventions exactly.

**Directory structure:**

```
<company-slug>/
├── COMPANY.md
├── agents/
│   └── <slug>/AGENTS.md
├── teams/
│   └── <slug>/TEAM.md        (if teams are needed)
├── projects/
│   └── <slug>/PROJECT.md     (if projects are needed)
├── tasks/
│   └── <slug>/TASK.md        (if tasks are needed)
├── skills/
│   └── <slug>/SKILL.md       (if custom skills are needed)
└── .paperclip.yaml            (Paperclip vendor extension)
```

**Rules:**

- Slugs must be URL-safe, lowercase, hyphenated
- COMPANY.md gets `schema: agentcompanies/v1` - other files inherit it
- Agent instructions go in the AGENTS.md body, not in .paperclip.yaml
- Skills referenced by shortname in AGENTS.md resolve to `skills/<shortname>/SKILL.md`
- For external skills, use `sources` with `usage: referenced` (see spec section 12)
- Do not export secrets, machine-local paths, or database IDs
- Omit empty/default fields
- For companies generated from a repo, add a references footer at the bottom of COMPANY.md body:
  `Generated from [repo-name](repo-url) with the company-creator skill from [Paperclip](https://github.com/paperclipai/paperclip)`

**Reporting structure:**

- Every agent except the CEO should have `reportsTo` set to their manager's slug
- The CEO has `reportsTo: null`
- For teams without a CEO, the top-level agent has `reportsTo: null`

**Writing workflow-aware agent instructions:**

Each AGENTS.md body should include not just what the agent does, but how they fit into the organization's workflow. Include:

1. **Where work comes from** — "You receive feature ideas from the user" or "You pick up tasks assigned to you by the CTO"
2. **What you produce** — "You produce a technical plan with architecture diagrams" or "You produce a reviewed, approved branch ready for shipping"
3. **Who you hand off to** — "When your plan is locked, hand off to the Staff Engineer for implementation" or "When review passes, hand off to the Release Engineer to ship"
4. **What triggers you** — "You are activated when a new feature idea needs product-level thinking" or "You are activated when a branch is ready for pre-landing review"

This turns a collection of agents into an organization that actually works together. Without workflow context, agents operate in isolation — they do their job but don't know what happens before or after them.

### Step 5: Confirm Output Location

Ask the user where to write the package. Common options:

- A subdirectory in the current repo
- A new directory the user specifies
- The current directory (if it's empty or they confirm)

### Step 6: Write README.md and LICENSE

**README.md** — every company package gets a README. It should be a nice, readable introduction that someone browsing GitHub would appreciate. Include:

- Company name and what it does
- The workflow / how the company operates
- Org chart as a markdown list or table showing agents, titles, reporting structure, and skills
- Brief description of each agent's role
- Citations and references: link to the source repo (if from-repo), link to the Agent Companies spec (https://agentcompanies.io/specification), and link to Paperclip (https://github.com/paperclipai/paperclip)
- A "Getting Started" section explaining how to import: `paperclipai company import --from <path>`

**LICENSE** — include a LICENSE file. The copyright holder is the user creating the company, not the upstream repo author (they made the skills, the user is making the company). Use the same license type as the source repo (if from-repo) or ask the user (if from-scratch). Default to MIT if unclear.

### Step 7: Write Files and Summarize

Write all files, then give a brief summary:

- Company name and what it does
- Agent roster with roles and reporting structure
- Skills (custom + referenced)
- Projects and tasks if any
- The output path

## .paperclip.yaml Guidelines

The `.paperclip.yaml` file is the Paperclip vendor extension. It configures adapters and env inputs per agent.

### Adapter Rules

**Do not specify an adapter unless the repo or user context warrants it.** If you don't know what adapter the user wants, omit the adapter block entirely — Paperclip will use its default. Specifying an unknown adapter type causes an import error.

Paperclip's supported adapter types (these are the ONLY valid values):
- `claude_local` — Claude Code CLI
- `codex_local` — Codex CLI
- `opencode_local` — OpenCode CLI
- `pi_local` — Pi CLI
- `cursor` — Cursor
- `gemini_local` — Gemini CLI
- `openclaw_gateway` — OpenClaw gateway

Only set an adapter when:
- The repo or its skills clearly target a specific runtime (e.g. gstack is built for Claude Code, so `claude_local` is appropriate)
- The user explicitly requests a specific adapter
- The agent's role requires a specific runtime capability

### Env Inputs Rules

**Do not add boilerplate env variables.** Only add env inputs that the agent actually needs based on its skills or role:
- `GH_TOKEN` for agents that push code, create PRs, or interact with GitHub
- API keys only when a skill explicitly requires them
- Never set `ANTHROPIC_API_KEY` as a default empty env variable — the runtime handles this

Example with adapter (only when warranted):
```yaml
schema: paperclip/v1
agents:
  release-engineer:
    adapter:
      type: claude_local
      config:
        model: claude-sonnet-4-6
    inputs:
      env:
        GH_TOKEN:
          kind: secret
          requirement: optional
```

Example — only agents with actual overrides appear:
```yaml
schema: paperclip/v1
agents:
  release-engineer:
    inputs:
      env:
        GH_TOKEN:
          kind: secret
          requirement: optional
```

In this example, only `release-engineer` appears because it needs `GH_TOKEN`. The other agents (ceo, cto, etc.) have no overrides, so they are omitted entirely from `.paperclip.yaml`.

## External Skill References

When referencing skills from a GitHub repo, always use the references pattern:

```yaml
metadata:
  sources:
    - kind: github-file
      repo: owner/repo
      path: path/to/SKILL.md
      commit: <full SHA from git ls-remote or the repo>
      attribution: Owner or Org Name
      license: <from the repo's LICENSE>
      usage: referenced
```

Get the commit SHA with:

```bash
git ls-remote https://github.com/owner/repo HEAD
```

Do NOT copy external skill content into the package unless the user explicitly asks.
