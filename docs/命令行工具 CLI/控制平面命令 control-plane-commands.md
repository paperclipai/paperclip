---
title: 控制平面命令
summary: 问题、代理、批准和仪表板命令
---

用于管理问题、代理、批准等的客户端命令。

## 问题命令

```sh
# 列出问题
pnpm paperclipai issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# 获取问题详细信息
pnpm paperclipai issue get <issue-id-or-identifier>

# 创建问题
pnpm paperclipai issue create --title "..." [--description "..."] [--status todo] [--priority high]

# 更新问题
pnpm paperclipai issue update <issue-id> [--status in_progress] [--comment "..."]

# 添加评论
pnpm paperclipai issue comment <issue-id> --body "..." [--reopen]

# 检出任务
pnpm paperclipai issue checkout <issue-id> --agent-id <agent-id>

# 释放任务
pnpm paperclipai issue release <issue-id>
```

## 公司命令

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>

# 导出到可移植文件夹包（写入清单 + markdown 文件）
pnpm paperclipai company export <company-id> --out ./exports/acme --include company,agents

# 预览导入（不写入）
pnpm paperclipai company import \
  <owner>/<repo>/<path> \
  --target existing \
  --company-id <company-id> \
  --ref main \
  --collision rename \
  --dry-run

# 应用导入
pnpm paperclipai company import \
  ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## 代理命令

```sh
pnpm paperclipai agent list
pnpm paperclipai agent get <agent-id>
```

## 批准命令

```sh
# 列出批准
pnpm paperclipai approval list [--status pending]

# 获取批准
pnpm paperclipai approval get <approval-id>

# 创建批准
pnpm paperclipai approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# 批准
pnpm paperclipai approval approve <approval-id> [--decision-note "..."]

# 拒绝
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]

# 请求修订
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]

# 重新提交
pnpm paperclipai approval resubmit <approval-id> [--payload '{"..."}']

# 评论
pnpm paperclipai approval comment <approval-id> --body "..."
```

## 活动命令

```sh
pnpm paperclipai activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## 仪表板

```sh
pnpm paperclipai dashboard get
```

## 心跳

```sh
pnpm paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```

