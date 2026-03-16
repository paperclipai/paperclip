# Anti-Patterns — Extended Catalog

## 1. Blob Storage in Fields

**What it looks like:**
```json
{
  "id": "doc-spec",
  "entityType": "Document",
  "fields": {
    "title": "API Spec",
    "content": "# API Spec\n\nThis document describes...\n\n[2000 more lines]"
  }
}
```

**Why it fails:**
- Blows up JSONL line length (JSON requires single-line per record)
- Makes the graph unreadable in any editor
- Slows every `loadGraph()` call even when you don't need the content
- Can't query or filter on blob content anyway

**Fix:** Store file path, not content.
```json
{
  "id": "doc-spec",
  "entityType": "Document",
  "fields": {
    "title": "API Spec",
    "filePath": "docs/api-spec.md",
    "wordCount": 2400,
    "lastEditedAt": "2026-03-16"
  }
}
```

---

## 2. Relations as Fields

**What it looks like:**
```json
{
  "id": "task-42",
  "entityType": "Task",
  "fields": {
    "title": "Fix auth bug",
    "assignedTo": "alice-smith",
    "partOf": "project-api-v2",
    "blockedBy": ["task-38", "task-40"]
  }
}
```

**Why it fails:**
- Invisible to relation traversal — `getRelations()` won't find these
- Can't query "all tasks assigned to Alice" via the standard relation query
- Updates require a full entity rewrite instead of adding/deleting a relation
- Cardinality enforcement impossible (how do you enforce one-to-one in a string field?)

**Fix:** Use relation records.
```json
{ "_type": "relation", "relationName": "assigned-to", "sourceId": "task-42", "targetId": "alice-smith", ... }
{ "_type": "relation", "relationName": "part-of", "sourceId": "task-42", "targetId": "project-api-v2", ... }
{ "_type": "relation", "relationName": "blocks", "sourceId": "task-38", "targetId": "task-42", ... }
```

---

## 3. Skipping the Schema File

**What it looks like:** Writing entities without a `schema.json`, relying on memory for what fields are valid.

**Why it fails:**
- Week 1: Task has `{ status: "todo" }`
- Week 2: New session. Task gets written with `{ state: "open" }` (different field name)
- Week 3: Another session writes `{ taskStatus: "in-progress" }` (another variation)
- Queries against `status` now miss 2/3 of tasks silently

**Fix:** Define schema.json first. Before writing any entity, verify the type and required fields are in schema. Treat schema as the migration log — add new fields by adding to schema, never by just writing them.

---

## 4. Overwriting JSONL Lines

**What it looks like:**
```bash
# "Fixing" an entity by overwriting the file
grep -v '"id":"task-42"' graph.jsonl > /tmp/graph_new.jsonl
echo '{"_type":"entity","id":"task-42",...}' >> /tmp/graph_new.jsonl
mv /tmp/graph_new.jsonl graph.jsonl
```

**Why it fails:**
- Loses history — you can no longer see what the entity looked like before
- If two agents write simultaneously, the line deletion + write is not atomic
- Breaks the audit trail that makes the graph trustworthy
- Any background process reading the file during the overwrite gets partial data

**Fix:** Always append. The last-write-wins read semantics means appending an updated record is a correct and safe update.

---

## 5. One Giant Entity Type

**What it looks like:**
```json
{
  "id": "project-auth-refactor",
  "entityType": "Project",
  "fields": {
    "name": "Auth Refactor",
    "tasks": ["fix oauth", "update middleware", "write tests"],
    "team": ["alice", "bob"],
    "decisions": ["use JWT", "deprecate sessions"],
    "blockers": "waiting on security review"
  }
}
```

**Why it fails:**
- Tasks embedded in fields can't be queried individually, assigned, or given status
- Team members as strings can't be traversed (can't ask "what's Alice working on?")
- Decisions aren't queryable, linkable, or time-stamped
- The whole record must be rewritten to update any part of it

**Fix:** Decompose into separate entity types linked by relations.
```
Project: { name, status, goalStatement }
Task: { title, status, priority } ← linked via part-of → Project
Person: { name, role } ← linked via assigned-to ← Task
Decision: { title, rationale, decidedAt } ← linked via made-in → Project
```

---

## 6. Schema Drift During Optimization

**What it looks like:** An Optimizer or refactoring pass rewrites SKILL.md and removes the `ontology:` block because "it's just metadata."

**Why it fails:** Other skills that were reading or respecting ownership of your types are now flying blind. The composability protocol breaks silently.

**Fix:** The `ontology:` block in frontmatter is not optional metadata — it's a contract declaration. Treat it like an exported API. If you change it, you're making a breaking change.

---

## 7. ID Instability

**What it looks like:**
```json
{ "id": "8f3a2d1c-4b5e-..." }  // UUID
{ "id": "entity_1234" }         // Auto-increment
{ "id": "task" }                // Not unique
```

**Why it fails:**
- UUIDs are opaque — Claude can't tell what entity is being referenced without a lookup
- Auto-increments require a counter somewhere (race condition in concurrent writes)
- Non-unique ids cause last-write-wins to silently merge unrelated entities

**Fix:** Use `{type}-{descriptor}` format: `task-add-retry-logic`, `person-alice-smith`, `project-auth-refactor`. Stable, human-readable, unique by convention.

---

## Recovery Patterns

| Problem | Recovery |
|---------|---------|
| Two incompatible entity shapes for same type | Write a migration: append new records with canonical shape, soft-delete old ones. Update schema. |
| Relations-as-fields already in prod | Add matching relation records. Keep fields for now (backwards compat). Mark fields as deprecated in schema. |
| Graph too large to read quickly | Run compaction (see 02-crud-operations.md). Set up a session-local cache. |
| Lost the schema.json | Reconstruct from the graph: extract all distinct `entityType` values, collect all `fields` keys per type, rebuild schema.json. |
