---
type: "memory"
title: "Production deploy window policy"
description: "Deploys ship Tue/Thu 14:00-16:00 UTC only."
resource: "paperclip:memory:deploy-window-policy"
tags:
  - "ops"
  - "policy"
timestamp: "2026-05-02T09:00:00Z"
---

# Production deploy window policy

Deploys ship Tue/Thu 14:00-16:00 UTC only.

Production deploys are restricted to Tuesday and Thursday, 14:00-16:00 UTC, to keep a human on-call during the rollout.

**Why:** off-hours rollbacks burned us twice in Q1.
**How to apply:** schedule release issues for those windows; block merges to `main` outside them via the deploy bot. See [[release-checklist]].
