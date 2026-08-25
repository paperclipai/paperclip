---
name: weknora-ingest
description: Prepare a board handoff for bounded WeKnora source ingestion.
---

# WeKnora Ingest

Agents do not have WeKnora write tools. If a source must be added, describe the proposed title, source URL or text, target knowledge base, and expected duplicate risk in the Paperclip issue.

Only a board user can run manual or URL ingest after the operator enables `enableWriteActions`. File and multipart ingest are not supported by this plugin. External writes are never retried automatically.
