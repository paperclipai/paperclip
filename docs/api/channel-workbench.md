---
title: Channel Workbench
summary: Endpoints for channel delivery workflow orchestration
---

The Channel Workbench API exposes workflow state, per-section detail, and inline actions for channel delivery.

## Overview

```
GET /api/companies/{companyId}/channel-workbench/overview?scenario={scenario}
```

Returns the top-level case summary, readiness, stage, snapshot state, blockers, and status summary.

## Next Actions

```
GET /api/companies/{companyId}/channel-workbench/next-actions?scenario={scenario}
```

Returns prioritized actions for the current workflow state, including owner role, target section, priority, and CTA metadata.

## Section Detail

Use these endpoints to load the detailed view for a specific section:

```
GET /api/companies/{companyId}/channel-workbench/source-documents?scenario={scenario}
GET /api/companies/{companyId}/channel-workbench/spec-editor?scenario={scenario}
GET /api/companies/{companyId}/channel-workbench/gate-result?scenario={scenario}
GET /api/companies/{companyId}/channel-workbench/issue-ledger?scenario={scenario}
GET /api/companies/{companyId}/channel-workbench/snapshot-export?scenario={scenario}
GET /api/companies/{companyId}/channel-workbench/evidence-dod?scenario={scenario}
GET /api/companies/{companyId}/channel-workbench/role-view?scenario={scenario}
```

Each response returns a scenario payload plus the detail needed for that section.

## Inline Actions

The workbench supports three inline workflow actions:

```
POST /api/companies/{companyId}/channel-workbench/rerun-gate?scenario={scenario}
POST /api/companies/{companyId}/channel-workbench/export-ai?scenario={scenario}
POST /api/companies/{companyId}/channel-workbench/upload-evidence?scenario={scenario}
```

These actions return the new action result and also write activity entries so the effective state can be recovered later.

## Scenario Parameter

The `scenario` query parameter selects a representative workflow state.

Supported values:

- `no_source`
- `spec_incomplete`
- `gate_failed`
- `gate_stale`
- `passed_with_exception`
- `dod_blocked`

If omitted, the server falls back to the default scenario for the workbench.
