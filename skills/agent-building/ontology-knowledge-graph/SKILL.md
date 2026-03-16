---
name: ontology-knowledge-graph
description: Use when you need typed entity tracking across sessions, structured queryable memory, or shared state between skills. Triggers on: "entity graph", "knowledge graph", "ontology", "structured memory", "JSONL memory", "track entities", "cross-skill state", "composability protocol", "outgrown MEMORY.md", "shared entity state", "typed queryable memory", "entity relations", "query entities". NOT for: Neo4j/graph database setup, vector/semantic search, visual graph UIs, or pure ontology concept explanations.
---

# Ontology & Knowledge Graph

Give Claude Code a typed, queryable entity graph in plain JSON Lines files — no external databases, no Python, no MCP overhead. Three primitives: **entities** (typed nodes), **relations** (typed edges), **schema** (constraints). Two files: `memory/ontology/graph.jsonl` (data) + `memory/ontology/schema.json` (constraints).

**When MEMORY.md isn't enough:** Can't query "all open Tasks assigned to Alice" (flat prose isn't filterable), can't maintain relational state (Person → assigned-to → Task needs linked entities), can't share typed state between skills (no protocol for interoperability).

## Quick Setup (5 Minutes)

1. Create `memory/ontology/` directory
2. Initialize `memory/ontology/schema.json` — see `references/01-schema-format.md` for structure
3. Create `memory/ontology/graph.jsonl` (empty file)
4. Add to `CLAUDE.md`:
   ```
   ## Entity Graph
   Structured memory at memory/ontology/. Read schema.json for valid types before writing.
   ```
5. Write your first entity — see `references/02-crud-operations.md`

## The Data Model

Two record types in `graph.jsonl`: `EntityRecord` (typed node) and `RelationRecord` (typed edge). Full TypeScript interfaces in `references/01-schema-format.md`.

**Append-only invariant:** Never delete or overwrite lines. Updates append a new record with the same `id` — last record wins. Soft-delete via `deletedAt`. Full audit trail, concurrent-write safe.

## Cross-Skill Composability Protocol

Declare what entity types your skill reads and writes by adding an `ontology:` block to its SKILL.md frontmatter:

```yaml
ontology:
  reads: [Task, Person]
  writes: [TestRun]
  owns: [TestRun]     # this skill is authoritative for TestRun entities
```

**Ownership rule:** If your skill owns a type, it's the sole writer. Other skills read only. Prevents conflicting updates.

Full protocol spec, worked example (TDD-workflow + code-review interop), and conflict prevention rules in `references/04-composability-protocol.md`.

## Anti-Patterns

| Anti-Pattern | Why It Fails |
|---|---|
| Storing file content in fields | Use the file path — fields are for structured metadata, not blobs |
| Relations as fields (`fields.ownedBy`) | Invisible to traversal — use a relation record |
| Skipping the schema file | Silent type drift — week 2 your Task has 3 incompatible shapes |
| Overwriting JSONL lines | Breaks audit trail and concurrent-write safety |
| One giant entity type | Split "Project" into Project + Task + Decision — traversal requires separate types |

More patterns and recovery examples in `references/05-anti-patterns.md`.

