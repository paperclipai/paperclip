---
name: ubiquitous-language
description: Use when Claude keeps using wrong domain terms, generic naming instead of team-specific vocabulary, or terminology drift in generated code. Triggers on: "Claude uses wrong terms", "Claude calls it X but we call it Y", "terminology consistency", "ubiquitous language", "domain glossary", "GLOSSARY.md", "DDD glossary", "naming conventions in Claude", "Claude ignores our team terms", "domain vocabulary", "shared language for Claude", "Claude uses generic names", "keep correcting Claude's naming", "terminology drift", "Claude substitutes generic terms". NOT for: full DDD entity/relationship modeling (use ontology-knowledge-graph #012), automated PR review for naming violations (use code-review-automation #011), NLP or semantic analysis, i18n/localization.
---

# Ubiquitous Language — Domain Glossary for AI Agents

One file. Every session. Claude speaks your domain's language automatically.

## The Problem

Claude defaults to generic naming: "user" instead of "subscriber", "transaction" instead of "settlement", "order" instead of "purchase order". Without a domain glossary, you correct the same terms every session — and the corrections don't stick.

## Quick Setup (3 Steps)

**Step 1 — Create GLOSSARY.md** in your repo root. See [01-glossary-template.md](references/01-glossary-template.md) for format and entry templates. Start with 5-10 terms you've already corrected at least once.

**Step 2 — Wire into CLAUDE.md:**

```
@GLOSSARY.md
```

**Step 3 — Install hooks** from [02-hooks.md](references/02-hooks.md):
- `SessionStart` hook: surfaces active glossary count at session start
- `PostToolUse` hook: flags anti-pattern terms in Write/Edit before they land in git

## GLOSSARY.md Structure

```markdown
## [Term]

**Definition:** What this means in your domain.
**Aliases:** What Claude might write instead — "user", "customer", "record"
**Anti-patterns:** NEVER say: "user", "account" — use "subscriber"
**Usage:** `subscriber.activePlan`, `subscriber.billingCycle`
```

See [01-glossary-template.md](references/01-glossary-template.md) for complete templates by entry type: entity, action, status, relationship. Includes a 10-entry starter for a SaaS subscription domain.

## Extracting Terms from an Existing Codebase

Starting from scratch? See [03-extraction-workflow.md](references/03-extraction-workflow.md) for a cold-start workflow: scan identifiers, scan docs, run the extraction prompt, prioritize by domain impact.

## Maintaining the Glossary

Adding new terms, deprecating old ones, handling team disagreements — see [04-maintenance.md](references/04-maintenance.md). Key rule: treat GLOSSARY.md like your schema. Rename in the glossary first, then refactor the code.

## Composing with Ontology (#012)

GLOSSARY.md = **what we call things**. Ontology (#012) = **how things relate**. Use both: ontology defines the graph structure, glossary enforces the names for every node and edge. See [05-composability-bridge.md](references/05-composability-bridge.md).

## Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "I'll just correct Claude when it gets the naming wrong" | You'll correct it 50 times. It won't remember. The glossary remembers. |
| "Our domain terms aren't that different from generic ones" | Different enough that you noticed. That's why you're here. |
| "I'll set up the PostToolUse hook later" | The hook is 8 lines. "Later" means wrong terms in git for 3 months. |
| "I need to extract all terms before I can start" | Start with 5 terms. Add more as Claude gets them wrong. The glossary grows with the codebase. |
| "CLAUDE.md loads from git root — GLOSSARY.md will auto-load" | It won't. You need the explicit `@GLOSSARY.md` line in CLAUDE.md. |

## Reference Index

| File | Contents |
|---|---|
| [01-glossary-template.md](references/01-glossary-template.md) | Full GLOSSARY.md format, entry templates by type, 10-entry starter example |
| [02-hooks.md](references/02-hooks.md) | SessionStart + PostToolUse hook code, configuration, tuning guide |
| [03-extraction-workflow.md](references/03-extraction-workflow.md) | Cold-start extraction workflow, prompt templates, prioritization criteria |
| [04-maintenance.md](references/04-maintenance.md) | Adding/deprecating terms, team disagreement workflow, update process |
| [05-composability-bridge.md](references/05-composability-bridge.md) | GLOSSARY.md vs. ontology layered model, derivation from existing ontology |
