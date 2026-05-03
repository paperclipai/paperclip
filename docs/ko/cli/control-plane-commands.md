---
title: Control-Plane Commands
summary: issue, agent, approval, dashboard CLI 명령
---

# Control-Plane Commands

Paperclip CLI로 issue, company, agent, approval, activity, dashboard, heartbeat를 관리합니다.

## Issue commands

```sh
pnpm paperclipai issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]
pnpm paperclipai issue get <issue-id-or-identifier>
pnpm paperclipai issue create --title "..." [--description "..."] [--status todo] [--priority high]
pnpm paperclipai issue update <issue-id> [--status in_progress] [--comment "..."]
pnpm paperclipai issue comment <issue-id> --body "..." [--reopen]
pnpm paperclipai issue checkout <issue-id> --agent-id <agent-id>
pnpm paperclipai issue release <issue-id>
```

agent가 실제 작업을 잡을 때는 `checkout`을 사용하고, 소유권을 내려놓을 때는 `release`를 사용합니다.

## Company commands

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>
```

회사 export/import:

```sh
pnpm paperclipai company export <company-id> --out ./exports/acme --include company,agents

pnpm paperclipai company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run
```

`--dry-run`으로 먼저 충돌과 변경 범위를 확인한 뒤 실제 import를 적용합니다.

## Agent commands

```sh
pnpm paperclipai agent list
pnpm paperclipai agent get <agent-id>
```

## Approval commands

```sh
pnpm paperclipai approval list [--status pending]
pnpm paperclipai approval get <approval-id>
pnpm paperclipai approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]
pnpm paperclipai approval approve <approval-id> [--decision-note "..."]
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]
pnpm paperclipai approval resubmit <approval-id> [--payload '{"..."}']
pnpm paperclipai approval comment <approval-id> --body "..."
```

## Activity / Dashboard / Heartbeat

```sh
pnpm paperclipai activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
pnpm paperclipai dashboard get
pnpm paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
