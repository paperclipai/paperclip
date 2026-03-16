# Query Patterns

All queries operate on the in-memory graph loaded by `loadGraph()` (see 02-crud-operations.md). Read the file once per session, not per query.

## Filter by Type

Get all entities of a given type (excluding deleted):

```typescript
function getByType(entities: Map<string, EntityRecord>, type: string): EntityRecord[] {
  return Array.from(entities.values()).filter(
    e => e.entityType === type && !e.deletedAt
  );
}

// Usage
const tasks = getByType(entities, 'Task');
```

## Filter by Field Value

```typescript
function getByField(
  entities: Map<string, EntityRecord>,
  type: string,
  field: string,
  value: unknown
): EntityRecord[] {
  return getByType(entities, type).filter(e => e.fields[field] === value);
}

// All open tasks
const openTasks = getByField(entities, 'Task', 'status', 'todo');

// All high-priority tasks
const highPriority = getByField(entities, 'Task', 'priority', 'high');
```

## Get Relations for an Entity

```typescript
function getRelations(
  relations: Map<string, RelationRecord>,
  entityId: string,
  direction: 'outgoing' | 'incoming' | 'both' = 'both'
): RelationRecord[] {
  return Array.from(relations.values()).filter(r => {
    if (r.deletedAt) return false;
    if (direction === 'outgoing') return r.sourceId === entityId;
    if (direction === 'incoming') return r.targetId === entityId;
    return r.sourceId === entityId || r.targetId === entityId;
  });
}
```

## Traversal — All Tasks in a Project

```typescript
function getTasksForProject(
  entities: Map<string, EntityRecord>,
  relations: Map<string, RelationRecord>,
  projectId: string
): EntityRecord[] {
  // Find all part-of relations where target is the project
  const taskRelations = Array.from(relations.values()).filter(
    r => r.relationName === 'part-of' && r.targetId === projectId && !r.deletedAt
  );

  // Resolve task entities
  return taskRelations
    .map(r => entities.get(r.sourceId))
    .filter((e): e is EntityRecord => !!e && !e.deletedAt);
}
```

## Reverse Lookup — All Tasks Assigned to a Person

```typescript
function getTasksAssignedTo(
  entities: Map<string, EntityRecord>,
  relations: Map<string, RelationRecord>,
  personId: string
): EntityRecord[] {
  const assignedRelations = Array.from(relations.values()).filter(
    r => r.relationName === 'assigned-to' && r.targetId === personId && !r.deletedAt
  );

  return assignedRelations
    .map(r => entities.get(r.sourceId))
    .filter((e): e is EntityRecord => !!e && !e.deletedAt);
}

// "All open tasks assigned to Alice"
const aliceId = 'alice-smith';
const aliceTasks = getTasksAssignedTo(entities, relations, aliceId);
const aliceOpenTasks = aliceTasks.filter(t => t.fields.status !== 'done');
```

## Aggregation

```typescript
// Count by field value
function countByField(
  entities: Map<string, EntityRecord>,
  type: string,
  field: string
): Record<string, number> {
  const items = getByType(entities, type);
  return items.reduce((acc, e) => {
    const val = String(e.fields[field] ?? 'null');
    acc[val] = (acc[val] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

// Task status breakdown
const taskStatusCounts = countByField(entities, 'Task', 'status');
// => { todo: 5, in_progress: 3, done: 12, blocked: 1 }
```

## Multi-Hop Traversal

Find all tasks that block other tasks (dependency chain):

```typescript
function getBlockerChain(
  entities: Map<string, EntityRecord>,
  relations: Map<string, RelationRecord>,
  taskId: string,
  visited = new Set<string>()
): EntityRecord[] {
  if (visited.has(taskId)) return []; // cycle guard
  visited.add(taskId);

  const blockedByRelations = Array.from(relations.values()).filter(
    r => r.relationName === 'blocks' && r.targetId === taskId && !r.deletedAt
  );

  const blockers: EntityRecord[] = [];
  for (const rel of blockedByRelations) {
    const blocker = entities.get(rel.sourceId);
    if (blocker && !blocker.deletedAt) {
      blockers.push(blocker);
      // Recurse to find upstream blockers
      blockers.push(...getBlockerChain(entities, relations, rel.sourceId, visited));
    }
  }
  return blockers;
}
```

## Query Composition Pattern

Load once, query many times:

```typescript
const { entities, relations } = loadGraph('memory/ontology/graph.jsonl');

// Compose queries
const projectId = 'project-auth-refactor';
const projectTasks = getTasksForProject(entities, relations, projectId);
const blockedTasks = projectTasks.filter(t => t.fields.status === 'blocked');
const blockers = blockedTasks.flatMap(t => getBlockerChain(entities, relations, t.id));

console.log(`Project has ${projectTasks.length} tasks, ${blockedTasks.length} blocked`);
```
