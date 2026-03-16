# CRUD Operations

All writes append to `memory/ontology/graph.jsonl`. Never overwrite or delete lines.

## Create Entity

Append a new entity record:

```json
{
  "_type": "entity",
  "id": "task-42",
  "entityType": "Task",
  "fields": {
    "title": "Add retry logic to API client",
    "status": "todo",
    "priority": "high"
  },
  "createdAt": "2026-03-16T10:00:00Z",
  "updatedAt": "2026-03-16T10:00:00Z"
}
```

**ID convention:** `{entityType-lowercase}-{short-descriptor}` — e.g., `task-42`, `alice-smith`, `project-auth-refactor`. Use stable, human-readable ids. Never use UUIDs — they're opaque.

## Add Relation

Append a relation record:

```json
{
  "_type": "relation",
  "id": "rel-task42-assigned-alice",
  "relationName": "assigned-to",
  "sourceId": "task-42",
  "targetId": "alice-smith",
  "createdAt": "2026-03-16T10:00:00Z"
}
```

## Update Entity Fields

Append a new entity record with the same `id` and updated fields + `updatedAt`:

```json
{
  "_type": "entity",
  "id": "task-42",
  "entityType": "Task",
  "fields": {
    "title": "Add retry logic to API client",
    "status": "in_progress",
    "priority": "high"
  },
  "createdAt": "2026-03-16T10:00:00Z",
  "updatedAt": "2026-03-16T14:30:00Z"
}
```

When reading, the last record with id `task-42` is current state. Earlier records are history.

## Soft-Delete

Add `deletedAt` to mark an entity as deleted. Never remove the original lines.

```json
{
  "_type": "entity",
  "id": "task-42",
  "entityType": "Task",
  "fields": { "title": "Add retry logic to API client", "status": "done", "priority": "high" },
  "createdAt": "2026-03-16T10:00:00Z",
  "updatedAt": "2026-03-16T18:00:00Z",
  "deletedAt": "2026-03-16T18:00:00Z"
}
```

## Reading the Graph

Load all lines, build current state map:

```typescript
function loadGraph(graphPath: string): {
  entities: Map<string, EntityRecord>;
  relations: Map<string, RelationRecord>;
} {
  const lines = fs.readFileSync(graphPath, 'utf8')
    .split('\n')
    .filter(l => l.trim());

  const entities = new Map<string, EntityRecord>();
  const relations = new Map<string, RelationRecord>();

  for (const line of lines) {
    const record = JSON.parse(line);
    if (record._type === 'entity') entities.set(record.id, record);
    if (record._type === 'relation') relations.set(record.id, record);
  }

  return { entities, relations };
}
```

Soft-deleted records are still in the map — filter with `!record.deletedAt` when querying.

## Compaction

When JSONL grows unwieldy (>500 lines, or slow reads):

1. Load the graph with `loadGraph()`
2. Filter to non-deleted entities and relations
3. Write each current record as a single line to a new file
4. Replace original with compacted file
5. Preserve the original as `graph.jsonl.bak` before replacing

**When to compact:** When load time is noticeable or file exceeds ~1MB. Not on every session.
