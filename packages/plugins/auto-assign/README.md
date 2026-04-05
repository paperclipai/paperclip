# @paperclipai/plugin-auto-assign

Auto-assign issues to agents based on emoji prefix in the issue title.

## Events

| Event | Condition | Action |
|-------|-----------|--------|
| `issue.created` | Title has emoji prefix, no assignee | Assign matching agent |
| `issue.updated` | Assignee cleared (non-null → null), title has emoji prefix | Re-assign matching agent |

## Configuration

Set `prefixMap` in plugin instance settings — keys are emoji characters, values are agent UUIDs:

```json
{
  "prefixMap": {
    "🔧": "f3bd3061-...",
    "✅": "e487e433-...",
    "🤖": "e487e433-...",
    "🚀": "24cbca9e-...",
    "🔍": "d5f472ba-...",
    "🎨": "f3bd3061-..."
  }
}
```

## Rules

- Does **not** overwrite an existing assignee
- No emoji prefix → no action
- `issue.updated` only triggers on assignee cleared (had value → null), not null→null
