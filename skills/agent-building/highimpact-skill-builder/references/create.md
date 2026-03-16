# Phase 1: Create — Building a New Skill from Scratch

## 1. Capture Intent

Extract from conversation or ask directly:

- **What should this skill enable Claude to do?** One clear sentence. If you can't say it in one sentence, the scope is wrong.
- **When should it trigger?** List 3-5 user phrases or contexts that signal this skill is needed.
- **What's the expected output?** Format, length, structure. Concrete beats vague.
- **Should we set up test cases?** Default heuristic:
  - Objective output (code, structured data, reports) → yes, always
  - Subjective output (tone rewrites, brainstorming) → suggest 1-2 cases anyway; user opts out

If the user said "turn this into a skill," extract the workflow from conversation history: what tools fired, in what order, what corrections were made. That sequence IS the skill draft.

---

## 2. Interview and Research

Don't just write what the user said. Probe:

- What inputs will vary? What stays constant?
- What does failure look like? What should Claude do then?
- Are there dependencies — MCPs, APIs, file formats, external tools?
- Is there a similar skill already? Check `skills/` before building from scratch.

Research before writing:
- Search available MCP docs if the skill touches external systems
- Find existing reference files in `references/` for reusable patterns
- If the skill involves a known format or protocol, look it up — don't guess

Don't move to writing until you can answer: what does a perfect run look like, start to finish?

---

## 3. Writing the SKILL.md

### Frontmatter

```yaml
---
name: kebab-case-name
description: |
  Imperative voice. 100-200 words. Sell the skill to the agent loading it.
  Focus on user intent, not mechanism. "When the user asks to X, do Y by Z."
  Be specific about when this skill applies and what the output delivers.
  Include key trigger phrases so the agent knows when to activate it.
---
```

### Body

- Write in imperative form: "Extract the...", "Ask the user...", "Generate..."
- Explain the WHY — "Check for existing skills first because rebuilding wastes tokens"
- Use Input/Output examples for anything non-obvious
- Progressive disclosure: keep SKILL.md under 500 lines; move reference material to `references/`
- When supporting multiple domains (e.g., iOS vs web), one reference file per domain

### Customization Block

Include this near the top of execution — after the intro, before the first step. Replace `{skill-name}` with the skill's directory name.

```markdown
## Customization

**Before executing, check for user customizations:**
1. Read `{project}/.claude/skill-customizations/{skill-name}/PREFERENCES.md` (if exists)
2. Read `~/.claude/skill-customizations/{skill-name}/PREFERENCES.md` (if exists)
3. Project-local overrides global. Both override skill defaults.
4. If neither exists, proceed with skill defaults.
```

Users create a `PREFERENCES.md` with freeform markdown — no schema needed. The LLM reads it and adjusts. Users who don't customize are unaffected. See `docs/conventions/skill-customization.md`.

---

### Example pattern

```markdown
## Step 2: Research

Search the codebase for existing implementations before generating new code.
This prevents duplication and catches naming conflicts early.

**Example:**
Input: "Add a dark mode toggle"
Action: Search for `darkMode`, `theme`, `colorScheme` before writing
Output: Either extend existing theme system or note there isn't one
```

---

## 4. Skill Anatomy

```
skill-name/
├── SKILL.md              # Required — entry point, loaded first
└── Bundled Resources     # Optional
    ├── Workflows/        # Sub-routing targets (for skills with 3+ modes)
    ├── scripts/          # Executable code for deterministic tasks
    ├── references/       # Docs loaded on demand (this file is one)
    └── assets/           # Templates, icons, fonts
```

Keep SKILL.md as the coordinator. References are overflow — loaded when a specific phase or domain needs depth. Scripts are for tasks where code is more reliable than prose instructions.

---

## 4a. Sub-Routing: When and How

Use sub-routing when the skill has 3+ distinct modes or SKILL.md would exceed 150 lines.

**Decision criteria:**

| Condition | Action |
|-----------|--------|
| 1-2 modes | Keep flat |
| 3+ modes OR >150 lines | Sub-routing |
| Modes share significant setup | Keep flat with clear section headers |

**SKILL.md router template (sub-routed skill):**

```markdown
---
name: skill-name
description: [triggers as before]
---

# Skill Name

[1-2 sentence overview]

## Workflow Routing

| Request Pattern | Route To |
|---|---|
| [trigger phrases] | `Workflows/WorkflowA.md` |
| [trigger phrases] | `Workflows/WorkflowB.md` |

## Dispatch Rules
- Match the user's request to the routing table above
- Read the matched workflow file and follow its instructions
- If no clear match, ask which symptom is closest
- Workflows may reference files in `references/` for supporting content

## Anti-Rationalization
[Keep here — applies to all workflows]
```

**Workflow file template:**

```markdown
# [Workflow Name]

## When to Use
[Specific triggers and context for this workflow]

## Steps
[Self-contained implementation steps]

## Verification
[How to verify this workflow completed correctly]

## Reference
See `../references/[file].md` for: [what's in that file].
```

**Rules:**
- Frontmatter stays in SKILL.md only — workflow files are instructions, not skills
- Workflow files are the single source of truth for their domain — no duplicate content in SKILL.md
- Workflow files can reference `../references/` content
- Anti-Rationalization table stays in SKILL.md — it applies across all workflows

---

## 5. Writing Patterns

**Define output formats with templates, not descriptions:**

```markdown
Output a JSON block:
{
  "skill_name": "...",
  "trigger_phrases": ["...", "..."],
  "output_format": "..."
}
```

**Good theory of mind — stay general:**
- Bad: "If the user says 'turn my Notion workflow into a skill'..."
- Good: "If the user references an existing workflow or conversation..."

**Review with fresh eyes:** After the first draft, re-read as if you're seeing the skill for the first time. Kill anything that requires context only you have.

**Anti-rationalization table (required for non-trivial skills):**

Every skill with a multi-step workflow must include an anti-rationalization section. Identify the 3-5 ways an agent using this skill will talk itself out of doing the hard parts, then preempt them.

Format:
```markdown
### Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "I can skip X because..." | Why X actually matters and what breaks without it |
```

Think about: what steps will the agent rationalize skipping? What corners will it cut? What "good enough" shortcuts lead to bad outcomes? The table should be specific to THIS skill's workflow — not generic advice.

If the skill is a simple reference doc or single-step utility, skip this. But if there's a loop, a multi-phase workflow, or quality gates — the table is mandatory.

---

## 6. Auto-generate Test Cases

After writing the skill draft, generate 2-3 realistic test prompts before asking for user approval. Show them:

```
Here are 3 test cases I'd suggest:
1. [Simple happy path]
2. [Edge case — missing input]
3. [Variant — different domain or format]

Want to adjust any before I save them?
```

Save approved cases to `evals/evals.json`:

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "...",
      "expected_output": "...",
      "files": []
    }
  ]
}
```

No assertions yet — those come during the Test phase. The goal here is just capturing what "good" looks like so you have a target when you run it.
