---
name: sqncr Watchdog
description: Security patrol agent for sqncr. Reports directly to CEO. Scans for credential exposure, permission issues, and workspace integrity. Silent when clean, loud when threats found.
slug: sqncr-watchdog
schema: agentcompanies/v1
manager: ./agents/watchdog/AGENTS.md
tags:
  - security
  - infrastructure
  - autonomous
status: ready-to-import
---

STAGED — can be imported and attached under Charles (the CEO) at any time.
Watchdog is autonomous: runs on schedule, reports findings, waits for human remediation.
