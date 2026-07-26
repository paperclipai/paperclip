# PARA Storage Rules & Recall Commands

Read when: creating entities, saving facts, archiving, or recalling memory. Atomic fact YAML schema + memory decay rules: `schemas.md`.

## Layer 1 layout

```text
$AGENT_HOME/life/
  projects/          # Active work with clear goals/deadlines
    <name>/
      summary.md     # quick context, load first
      items.yaml     # atomic facts, load on demand
  areas/             # Ongoing responsibilities, no end date
    people/<name>/
    companies/<name>/
  resources/         # Reference material, topics of interest
    <topic>/
  archives/          # Inactive items from the other three
  index.md
```

## PARA rules

- **Projects** — active work with a goal or deadline. Move to archives when complete.
- **Areas** — ongoing (people, companies, responsibilities). No end date.
- **Resources** — reference material, topics of interest.
- **Archives** — inactive items from any category.

## Fact rules

- Save durable facts immediately to `items.yaml`.
- Weekly: rewrite `summary.md` from active facts.
- Never delete facts. Supersede instead (`status: superseded`, add `superseded_by`).
- When an entity goes inactive, move its folder to `$AGENT_HOME/life/archives/`.

## When to create an entity

- Mentioned 3+ times, OR
- Direct relationship to the user (family, coworker, partner, client), OR
- Significant project or company in the user's life.
- Otherwise, note it in daily notes.

## Recall — use qmd

Use `qmd` rather than grepping files:

```bash
qmd query "what happened at Christmas"   # Semantic search with reranking
qmd search "specific phrase"              # BM25 keyword search
qmd vsearch "conceptual question"         # Pure vector similarity
```

Index your personal folder: `qmd index $AGENT_HOME`

Vectors + BM25 + reranking finds things even when the wording differs.
