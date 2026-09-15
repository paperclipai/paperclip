# Paperclip 本地使用清单（Hermes 版）

## 每次启动

1. 启动 Paperclip
2. 打开对应实例 UI（默认常见为 <http://127.0.0.1:3100>）
3. 如果当前实例不在 `3100`，先设置：`export PAPERCLIP_API_BASE="http://127.0.0.1:<port>/api"`
4. 先运行：`pnpm hermes:verify`
5. 确认 `/api/adapters` 里有 `hermes_local`

## 创建一个新 Hermes agent 时

- 优先使用 `doc/templates/hermes-local-agent.json`
- 先把模板中的 `REPLACE_PAPERCLIP_API_BASE` 改成当前实例 API 地址
- 默认不要显式写 `model`
- 默认不要显式写 `provider`
- 先给 `toolsets: terminal,file`
- 先把 `persistSession` 设成 `false`

## 做最小 demo 时

- 临时模式：直接运行 `pnpm hermes:demo`
- 回归模式：`pnpm hermes:demo -- --company-id <company-id> --agent-id <agent-id>`
- 如果手动做：用 `doc/templates/hermes-demo-issue.json`
- 替换 `assigneeAgentId`
- 创建 issue 后等待 assignment wakeup 自动触发
- 查看：
  - issue 状态
  - issue comments
  - heartbeat runs
  - run log

## 观察结果的 4 个 API

```bash
GET /api/issues/{issueId}
GET /api/issues/{issueId}/comments
GET /api/companies/{companyId}/heartbeat-runs?agentId={agentId}&limit=20
GET /api/heartbeat-runs/{runId}/log
```

## 一键入口

```bash
pnpm hermes:verify
pnpm hermes:demo
pnpm hermes:demo -- --company-id <company-id> --agent-id <agent-id>
```

## 已知本机特性

- 启动入口使用 `cli/node_modules/tsx/dist/cli.mjs`
- 当前分支的 Hermes 接入以 **plugin-only** 模式为准，可通过 Adapter manager 或 `~/.paperclip/adapter-plugins.json` 的 `file:` 路径做本地开发接入
- 当前 adapter 已修复：
  - Python 检测误报
  - 默认模型错误绑到 Anthropic
