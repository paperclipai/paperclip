---
name: ontology-knowledge-graph
description: Use when you need typed entity tracking across sessions, structured queryable memory, or shared state between skills. Triggers on: "entity graph", "knowledge graph", "ontology", "structured memory", "JSONL memory", "track entities", "cross-skill state", "composability protocol", "outgrown MEMORY.md", "shared entity state", "typed queryable memory", "entity relations", "query entities". NOT for: Neo4j/graph database setup, vector/semantic search, visual graph UIs, or pure ontology concept explanations.
---

# Ontology & Knowledge Graph

Give Claude Code a typed, queryable entity graph in plain JSON Lines files. Any skill can read and write structured state — no external databases, no Python, no MCP overhead.

Three primitives: **entities** (typed nodes), **relations** (typed edges), **schema** (constraints).

---

## Why Flat Files Break Down

MEMORY.md fails when you need to:
- Query "all open Tasks assigned to Alice" — can't filter flat prose
- Maintain relational state — Person → assigned-to → Task needs both entities linked
- Share typed state between skills — no protocol for interoperability

The entity graph solves this with two files: `memory/ontology/graph.jsonl` (data) + `memory/ontology/schema.json` (constraints).

---

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

---

## The Data Model

```typescript
// Entity record — one JSON object per JSONL line
interface EntityRecord {
  _type: "entity";
  id: string;           // stable, human-readable ("task-42", "alice-smith")
  entityType: string;   // must match a type in schema.json
  fields: Record<string, unknown>;
  createdAt: string;    // ISO 8601
  updatedAt: string;
  deletedAt?: string;   // soft-delete only — never remove lines
}

// Relation record
interface RelationRecord {
  _type: "relation";
  id: string;
  relationName: string; // must match a relation in schema.json
  sourceId: string;
  targetId: string;
  createdAt: string;
  deletedAt?: string;
}
```

**Append-only invariant:** Never delete or overwrite lines. Updates append a new record with the same `id` — last record wins when reading. Soft-delete via `deletedAt`. This gives concurrent-write safety and a full audit trail.

To read the graph: load all lines → group by `id` → last record per id is current state.

---

## Schema Definition

Schema structure, field types, enums, cardinality rules, and a worked example (People, Tasks, Decisions, Dependencies for a software project) in `references/01-schema-format.md`.

---

## CRUD Operations

Exact JSON patterns for: create entity, add relation, update fields, soft-delete, and compaction (when JSONL grows large). See `references/02-crud-operations.md`.

---

## Querying the Graph

Filter by type, filter by field value, traverse relations, reverse lookups, aggregation. See `references/03-query-patterns.md`.

---

## Cross-Skill Composability Protocol

Declare what entity types your skill reads and writes by adding an `ontology:` block to its SKILL.md frontmatter:

```yaml
ontology:
  reads: [Task, Person]
  writes: [TestRun]
  owns: [TestRun]     # this skill is authoritative for TestRun entities
```

**Ownership rule:** If your skill owns a type, it's the sole writer. Other skills read only. Prevents conflicting updates.

**Example:** A TDD-workflow skill declares `writes: [TestRun]` and `reads: [Task]`. After red-green-refactor completes, it appends a TestRun entity linked to the Task. Any orchestrator can query TestRun entities to see test history.

Full protocol spec, worked example, and conflict prevention rules in `references/04-composability-protocol.md`.

---

## Anti-Patterns

| Anti-Pattern | Why It Fails |
|---|---|
| Storing file content in fields | Use the file path — fields are for structured metadata, not blobs |
| Relations as fields (`fields.ownedBy`) | Invisible to traversal — use a relation record |
| Skipping the schema file | Silent type drift — week 2 your Task has 3 incompatible shapes |
| Overwriting JSONL lines | Breaks audit trail and concurrent-write safety |
| One giant entity type | Split "Project" into Project + Task + Decision — traversal requires separate types |

More patterns and recovery examples in `references/05-anti-patterns.md`.

---

## Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "MEMORY.md is simpler, I'll stick with it" | Until you need to query it. Prose can't answer "all open tasks for Alice" without reading everything and hoping. |
| "I don't need a schema file, I'll keep types in my head" | The schema IS the contract. Skip it and week-2 you write incompatible shapes with no error. |
| "Overwriting a line is fine for small graphs" | It breaks compaction, audit trail, and concurrent writes. Append invariant isn't a suggestion. |
| "I'll add the ontology: header to my skill later" | Later means never. It's 4 lines — add it when you write the skill. |
| "Other skills can just parse my MEMORY.md" | Prose is not a protocol. The `ontology:` header is machine-readable intent. |

---

## Reference Files

| File | Contents |
|------|----------|
| `references/01-schema-format.md` | Schema JSON structure, field types, enums, cardinality, worked example |
| `references/02-crud-operations.md` | Create/read/update/delete patterns, compaction workflow |
| `references/03-query-patterns.md` | Filter by type/field, traversal, reverse lookup, aggregation |
| `references/04-composability-protocol.md` | `ontology:` header spec, ownership rules, conflict prevention, worked example |
| `references/05-anti-patterns.md` | Extended anti-pattern catalog with real failure examples and recovery patterns |
