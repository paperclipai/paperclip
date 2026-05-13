# Schemas and Memory Decay

## Atomic Fact Schema (items.yaml)

```yaml
- id: entity-001
  fact: "The actual fact"
  category: relationship | milestone | status | preference
  timestamp: "YYYY-MM-DD"
  source: "YYYY-MM-DD"
  status: active # active | superseded
  superseded_by: null # e.g. entity-002
  related_entities:
    - companies/acme
    - people/jeff
  last_accessed: "YYYY-MM-DD"
  access_count: 0
```

## Memory Decay

Facts decay in retrieval priority over time so stale info does not crowd out recent context.

**Access tracking:** When a fact is used in conversation, bump `access_count` and set `last_accessed` to today. During heartbeat extraction, scan the session for referenced entity facts and update their access metadata.

**Recency tiers (for summary.md rewriting):**

- **Hot** (accessed in last 7 days) -- include prominently in summary.md.
- **Warm** (8-30 days ago) -- include at lower priority.
- **Cold** (30+ days or never accessed) -- omit from summary.md. Still in items.yaml, retrievable on demand.
- High `access_count` resists decay -- frequently used facts stay warm longer.

**Weekly synthesis:** Sort by recency tier, then by access_count within tier. Cold facts drop out of the summary but remain in items.yaml. Accessing a cold fact reheats it.

No deletion. Decay only affects retrieval priority via summary.md curation. The full record always lives in items.yaml.
