# Schema Format

The schema file defines valid entity types, their fields, and valid relation types between them.

## Schema JSON Structure

```json
{
  "entityTypes": {
    "Person": {
      "fields": {
        "name": { "type": "string", "required": true },
        "email": { "type": "string" },
        "role": { "type": "enum", "values": ["engineer", "designer", "pm", "stakeholder"] }
      }
    },
    "Task": {
      "fields": {
        "title": { "type": "string", "required": true },
        "status": {
          "type": "enum",
          "values": ["todo", "in_progress", "done", "blocked"],
          "required": true
        },
        "priority": { "type": "enum", "values": ["critical", "high", "medium", "low"] },
        "description": { "type": "string" }
      }
    },
    "Project": {
      "fields": {
        "name": { "type": "string", "required": true },
        "status": { "type": "enum", "values": ["active", "paused", "complete"] },
        "goalStatement": { "type": "string" }
      }
    },
    "Decision": {
      "fields": {
        "title": { "type": "string", "required": true },
        "rationale": { "type": "string" },
        "decidedAt": { "type": "date" },
        "alternatives": { "type": "string[]" }
      }
    }
  },
  "relationTypes": {
    "assigned-to": {
      "sourceType": "Task",
      "targetType": "Person",
      "cardinality": "many-to-one"
    },
    "part-of": {
      "sourceType": "Task",
      "targetType": "Project",
      "cardinality": "many-to-one"
    },
    "blocks": {
      "sourceType": "Task",
      "targetType": "Task",
      "cardinality": "many-to-many"
    },
    "made-in": {
      "sourceType": "Decision",
      "targetType": "Project",
      "cardinality": "many-to-one"
    }
  }
}
```

## Field Types

| Type | Description | Example |
|------|-------------|---------|
| `string` | Plain text | `"claude"` |
| `number` | Numeric value | `42` |
| `boolean` | True/false | `true` |
| `date` | ISO 8601 string | `"2026-03-16"` |
| `enum` | Fixed value set — requires `values` array | `"todo"` |
| `string[]` | Array of strings | `["option-a", "option-b"]` |

## Cardinality Rules

| Cardinality | Meaning | Enforcement |
|-------------|---------|-------------|
| `many-to-one` | Many sources can point to one target | Read-time: warn if target doesn't exist |
| `one-to-many` | One source can have many targets | Read-time: validate source uniqueness |
| `many-to-many` | No cardinality restriction | No enforcement needed |

**Schema validation is read-time, not write-time.** Claude validates on read/query to keep writes fast. Flag violations as warnings, not errors — append-only means you can't roll back.

## Working Example — Software Project

This schema tracks a real software project with 4 entity types and 4 relation types:

- **Person** — team members with roles
- **Task** — work items with status and priority
- **Project** — containers for tasks with a goal
- **Decision** — architectural/product choices with rationale

Relations:
- Task `assigned-to` Person (who owns it)
- Task `part-of` Project (which project it belongs to)
- Task `blocks` Task (dependency graph)
- Decision `made-in` Project (which project drove the decision)

This schema supports queries like:
- "All `in_progress` tasks in Project X" → filter entities by type + field + traverse part-of
- "Who is blocking Task Y" → find all Task→blocks→Task relations where targetId = Task Y's id
- "All decisions made in Project X" → traverse made-in reverse
