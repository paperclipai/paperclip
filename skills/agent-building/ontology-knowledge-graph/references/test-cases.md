# Test Cases — Ontology & Knowledge Graph

## Trigger Tests (Should Fire)

| ID | Prompt | Expected Behavior |
|----|--------|------------------|
| T01 | "set up an entity graph in my project" | Skill fires, guides through Quick Setup |
| T02 | "I need to track people, tasks, and decisions across sessions" | Skill fires, introduces data model |
| T03 | "I've outgrown MEMORY.md, I need structured memory" | Skill fires, explains why flat files break |
| T04 | "help me set up the knowledge graph skill" | Skill fires, begins setup flow |
| T05 | "how do I share entity state between skills" | Skill fires, explains composability protocol |
| T06 | "set up a knowledge graph for tracking my project" | Skill fires, guides setup |
| T07 | "I need typed queryable memory for Claude Code" | Skill fires, explains data model |
| T08 | "how does the cross-skill composability protocol work" | Skill fires, explains ontology: header |
| T09 | "create a JSONL entity store" | Skill fires, explains the append-only pattern |
| T10 | "I need to query all tasks assigned to Alice" | Skill fires, shows query patterns |
| T11 | "I need an ontology for my codebase" | Skill fires, introduces full skill |
| T12 | "how do I track entities and relations in Claude Code" | Skill fires, introduces primitives |

## No-Trigger Tests (Should NOT Fire)

| ID | Prompt | Expected Behavior |
|----|--------|------------------|
| N01 | "what is ontology in philosophy?" | Should NOT fire — pure concept explanation |
| N02 | "set up Neo4j in my Node.js project" | Should NOT fire — graph database, different tool |
| N03 | "add semantic search to my app" | Should NOT fire — vector search, out of scope |
| N04 | "explain knowledge graphs to me" | Should NOT fire — tutorial/explanation, not skill invocation |
| N05 | "how do I use MEMORY.md for session memory?" | Should NOT fire — flat memory, different skill |

## Output Assertions

### A01 — Quick Setup outputs 5-step process
**Given:** Trigger T01 or T04
**Assert:**
- [ ] Creates `memory/ontology/` directory path
- [ ] Mentions `schema.json` and `graph.jsonl`
- [ ] Includes CLAUDE.md snippet
- [ ] References `01-schema-format.md` for schema details
- [ ] References `02-crud-operations.md` for first write

### A02 — Data model includes TypeScript interfaces
**Given:** Trigger T02 or T07
**Assert:**
- [ ] Shows `EntityRecord` interface with `_type`, `id`, `entityType`, `fields`, `createdAt`, `updatedAt`, `deletedAt?`
- [ ] Shows `RelationRecord` interface with `_type`, `id`, `relationName`, `sourceId`, `targetId`
- [ ] Explains append-only invariant
- [ ] Explains last-write-wins read semantics

### A03 — Composability protocol shows `ontology:` header
**Given:** Trigger T05 or T08
**Assert:**
- [ ] Shows YAML frontmatter block with `reads:`, `writes:`, `owns:` fields
- [ ] Explains ownership rule (sole writer)
- [ ] Includes a worked example with 2 skills interoperating
- [ ] References `04-composability-protocol.md` for full spec

### A04 — Query output shows filter + traversal patterns
**Given:** Trigger T10
**Assert:**
- [ ] Shows `loadGraph()` usage
- [ ] Shows filter by type
- [ ] Shows traversal via relation (assigned-to)
- [ ] Output is TypeScript or pseudocode (not just prose)

### A05 — MEMORY.md comparison explains the pain
**Given:** Trigger T03
**Assert:**
- [ ] Names the specific failure mode (can't query, no type safety, no relations)
- [ ] Contrasts flat prose vs entity graph
- [ ] Does NOT suggest MEMORY.md is sufficient for any of the use cases

### A06 — Schema output matches schema.json structure
**Given:** Schema setup request
**Assert:**
- [ ] Output includes `entityTypes` and `relationTypes` top-level keys
- [ ] At least one entity type with `fields` containing types and `required`
- [ ] At least one relation type with `sourceType`, `targetType`, `cardinality`
