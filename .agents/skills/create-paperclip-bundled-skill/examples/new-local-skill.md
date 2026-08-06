# Example — MAKE path: idea → new optional catalog skill

Real run: PAP-15684 → PR #10410 (`feat(skills-catalog): add optional
/simplified-english skill`).

## Input

Task from Dotta: "make a skill that has agents write user-facing text in
Simplified English." No tweet this time — the source is a known public
specification (ASD-STE100 Simplified Technical English).

## Step 1 — FIND

- `grep -i 'simplified\|plain.english' packages/skills-catalog/generated/catalog.json`
  → no hits; nothing in `.agents/skills/` or `skills/` either.
- `gh search code --filename SKILL.md "simplified technical english"` → no
  usable published skill (only STE checker tools, no SKILL.md procedure).
- Verdict: **MAKE** a new local skill.

## Step 2 — Placement

- kind: `optional` (useful, but not something every company must ship with).
- category: `content` (existing category, fits writing/communication).
- slug: `simplified-english`.
- Path: `packages/skills-catalog/catalog/optional/content/simplified-english/`.

## Step 2B — Authoring

One markdown-only `SKILL.md` (trust level stays `markdown_only`):

```markdown
---
name: simplified-english
description: Write user-facing comments, plans, and documents in ASD-STE100 Simplified Technical English — short, unambiguous sentences with approved words and one meaning each — so readers understand them the first time.
key: paperclipai/optional/content/simplified-english
recommendedForRoles:
  - engineer
  - product
  - writer
  - devrel
tags:
  - writing
  - communication
  - clarity
  - style
---

# Simplified English

For user-facing comments, plans, and documents, write using only ASD-STE100
Simplified Technical English.

## Core rules

- Use short sentences (procedures ≤ 20 words, descriptions ≤ 25 words).
- Give one instruction per sentence.
- Use approved words with one meaning each; avoid synonyms and jargon.
...
```

Note the frontmatter hits every builder rule: description is 40–300 chars,
`key` matches the placement, roles and tags are non-empty.

## Steps 3–4 — Examples, manifest, tests

- Add `examples/rewrite-status-comment.md` showing a jargon-heavy status
  comment rewritten under the rules (before/after).
- `pnpm --filter @paperclipai/skills-catalog build:manifest` → regenerates
  `generated/catalog.json` with the new entry.
- Add `"paperclipai/optional/content/simplified-english"` to
  `EXPECTED_OPTIONAL_KEYS` in `src/shipped-catalog.test.ts` (alphabetical).
- `pnpm --filter @paperclipai/skills-catalog test` → green.

## Step 5 — PR

Four-part diff:

```
packages/skills-catalog/catalog/optional/content/simplified-english/SKILL.md
packages/skills-catalog/catalog/optional/content/simplified-english/examples/rewrite-status-comment.md
packages/skills-catalog/generated/catalog.json
packages/skills-catalog/src/shipped-catalog.test.ts
```

(The historical PR #10410 predates this skill and shipped as a three-part
diff without the `examples/` file; a run that follows this skill includes the
worked example from Step 3 in the same PR.)

PR body links the ASD-STE100 spec as the source and states trust level
`markdown_only`.
