# Cross-Skill Composability Protocol

The composability protocol lets skills declare their ontology contract — what they read and write — so other skills and orchestrators can reason about data ownership without inspecting code.

## The `ontology:` Header

Add to your skill's SKILL.md frontmatter (inside the `---` block):

```yaml
---
name: tdd-workflow
description: ...
ontology:
  reads: [Task]
  writes: [TestRun]
  owns: [TestRun]
---
```

### Fields

| Field | Required | Meaning |
|-------|----------|---------|
| `reads` | if skill reads graph | Entity types this skill queries but doesn't write |
| `writes` | if skill writes graph | Entity types this skill appends records for |
| `owns` | if skill is authoritative | Types where this skill is the sole writer |

**If your skill doesn't touch the graph, omit the `ontology:` block entirely.**

## Ownership Rule

When a skill declares `owns` for a type, it is the sole writer for that type. Other skills may read, but must not write. This prevents conflicting updates.

```
TDD-workflow owns: [TestRun]
→ Code-review skill may read TestRun entities
→ Code-review skill may NOT create TestRun entities
```

If two skills both need to write the same type, one of two paths:
1. Rename one skill's type to be more specific (`UnitTestRun` vs `IntegrationTestRun`)
2. Designate one skill as owner, other as contributor (no `owns`, write with source field)

## Worked Example — TDD Workflow + Ontology

**Scenario:** TDD-workflow skill tracks test runs. Code-review skill uses that history.

**TDD-workflow SKILL.md:**
```yaml
ontology:
  reads: [Task, Project]
  writes: [TestRun]
  owns: [TestRun]
```

When red-green-refactor completes for task `task-42`, TDD-workflow appends:
```json
{
  "_type": "entity",
  "id": "testrun-task42-2026-03-16",
  "entityType": "TestRun",
  "fields": {
    "taskId": "task-42",
    "phase": "green",
    "testCount": 12,
    "passRate": 1.0,
    "duration": "4.2s"
  },
  "createdAt": "2026-03-16T15:30:00Z",
  "updatedAt": "2026-03-16T15:30:00Z"
}
```

And links it to the task:
```json
{
  "_type": "relation",
  "id": "rel-testrun-task42",
  "relationName": "validates",
  "sourceId": "testrun-task42-2026-03-16",
  "targetId": "task-42",
  "createdAt": "2026-03-16T15:30:00Z"
}
```

**Code-review SKILL.md:**
```yaml
ontology:
  reads: [Task, TestRun, Person]
```

Before reviewing a PR, code-review queries: "what TestRuns exist for this Task? What's the pass rate?" — without knowing anything about TDD-workflow's internals.

## Schema Compatibility Declaration

When your skill writes an entity type, add it to the shared `schema.json` if not already there. This is the compatibility contract. Use a comment-by-convention field for ownership tracking:

```json
"TestRun": {
  "_owner": "tdd-workflow",
  "fields": {
    "taskId": { "type": "string", "required": true },
    "phase": { "type": "enum", "values": ["red", "green", "refactor"], "required": true },
    "testCount": { "type": "number" },
    "passRate": { "type": "number" },
    "duration": { "type": "string" }
  }
}
```

The `_owner` field is metadata only — Claude reads it to know who owns the type, not enforced at write time.

## Discovery — What Skills Write What

Orchestrators can discover the ontology contract for any skill by reading its SKILL.md frontmatter. No runtime introspection needed — it's static metadata.

```typescript
// Pseudocode: orchestrator discovering skill contracts
function discoverOntologyContracts(skillsDir: string): OntologyContract[] {
  const skills = glob(`${skillsDir}/**/SKILL.md`);
  return skills
    .map(path => parseFrontmatter(readFile(path)))
    .filter(fm => fm.ontology)
    .map(fm => ({ skill: fm.name, ...fm.ontology }));
}
```

Result:
```
tdd-workflow      → reads [Task, Project], owns [TestRun]
code-review       → reads [Task, TestRun, Person]
persistent-memory → reads [any], writes [MemoryEntry], owns [MemoryEntry]
```

## Conflict Prevention Rules

1. **One owner per type.** If you see two skills declaring `owns` for the same type, one must rename.
2. **Reads don't need declaration.** Only declare `reads` for types your skill actively queries (helps orchestrators build dependency graphs).
3. **Don't write types you don't own.** If you need to annotate an entity you don't own, write a new type that references it by id.
4. **Schema is a public contract.** Never change field semantics for a type you own without versioning (add a new field, keep the old one).
5. **Source tracking.** Non-owner writes should include a `_source` field in the entity for debugging:
   ```json
   { "fields": { "_source": "code-review", "annotation": "needs refactor" } }
   ```
