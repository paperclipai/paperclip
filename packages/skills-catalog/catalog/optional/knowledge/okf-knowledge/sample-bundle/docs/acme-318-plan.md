---
type: "document"
title: "Orders → Postgres migration plan"
resource: "paperclip:document:ACME-318:plan"
tags:
  - "architecture"
timestamp: "2026-03-16T09:00:00Z"
---

# Orders → Postgres migration plan

Phase 1: dual-write. Phase 2: backfill. Phase 3: cut reads over. Phase 4: retire Dynamo tables. Decision context: [ACME-318](/decisions/acme-318.md).
