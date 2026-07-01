# Paperclip + Hermes 本地工作流（已在本机验证）

> 环境：`/Users/neo/projects/paperclip` + `/Users/neo/projects/hermes-paperclip-adapter`
>
> 本文档记录一套在这台机器上已经实跑成功的最小可用工作流：启动 Paperclip、本地接入 Hermes、创建 agent、下发 issue、观察执行结果。

---

## 0. 新增：一键入口

在 `paperclip` repo 根目录现在可直接运行：

```bash
pnpm hermes:verify
pnpm hermes:demo
```

如果当前实例不在默认 `3100`，先显式指定 API base：

```bash
export PAPERCLIP_API_BASE="http://127.0.0.1:<port>/api"
```

### `pnpm hermes:verify`

用途：
- 检查 Hermes CLI 是否可运行
- 检查 `/api/adapters` 中是否存在 `hermes_local`
- 调用 `test-environment`
- 列出当前实例中的 companies

适合场景：
- 每次启动后先做环境体检
- 更新 adapter 后确认修复仍生效

### `pnpm hermes:demo`

用途：
- 默认模式：自动创建临时 company + agent + demo issue
- 回归模式：复用已有 company / agent，仅创建新的 demo issue
- 自动轮询 execution run
- 自动校验：
  - issue 最终为 `done`
  - comment 中包含 `DEMO_DONE`
  - heartbeat run 最终 `succeeded`

注意：
- 这两个脚本默认会优先读取 `PAPERCLIP_API_BASE`
- 若未设置，则回退读取 `.paperclip/config.json` 中的 `server.port`
- 只有在两者都拿不到时，才回退到 `http://127.0.0.1:3100/api`

可选参数：

```bash
pnpm hermes:demo -- --company-name "Hermes Demo Co"
pnpm hermes:demo -- --issue-title "Custom demo issue"
pnpm hermes:demo -- --timeout-sec 240 --poll-sec 5
pnpm hermes:demo -- --company-id <company-id> --agent-id <agent-id>
```

### 回归模式（复用已有 company / agent）

当你已经有一个稳定的 Hermes company / agent，希望重复做回归验证时，推荐直接：

```bash
pnpm hermes:demo -- \
  --company-id 5206167d-028f-4f9a-9efe-a29f5ce6d7b3 \
  --agent-id 7dd59715-9ac3-4943-ac2c-eab2659d4592 \
  --issue-title "Hermes regression issue"
```

此模式下脚本会：
- 复用已有 company
- 复用已有 `hermes_local` agent
- 只创建一条新的 demo / regression issue
- 等待该 agent 自动处理并验证结果

适合做：
- 每次升级 adapter 后的回归测试
- 每次更新 Hermes 配置后的烟雾验证
- 长期保留同一公司/同一 agent 的稳定回归入口

---

## 1. 当前本机已验证的前提

- Paperclip 仓库：`/Users/neo/projects/paperclip`
- Hermes adapter 仓库：`/Users/neo/projects/hermes-paperclip-adapter`
- Paperclip config：`/Users/neo/projects/paperclip/.paperclip/config.json`
- Paperclip instance id：`paperclip-local`
- Paperclip API / UI：`http://127.0.0.1:3100`
- Hermes CLI：本机可运行
- Hermes 实际运行 Python：`3.14.3`

---

## 2. 启动 Paperclip

在 Paperclip repo 根目录运行：

```bash
cd /Users/neo/projects/paperclip
PAPERCLIP_CONFIG=/Users/neo/projects/paperclip/.paperclip/config.json \
PAPERCLIP_INSTANCE_ID=paperclip-local \
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts run
```

启动后：

- UI：<http://127.0.0.1:3100>
- API：<http://127.0.0.1:3100/api>

快速检查：

```bash
curl -sS http://127.0.0.1:3100/api/adapters
```

预期能看到：

- `hermes_local`

---

## 3. 更新 Hermes adapter 到本地源码版本

本 fork/分支当前应优先按 **plugin-only** 模式接入 Hermes，不建议在 `server/` 里直接添加内联依赖。

推荐做法：
- 通过 **Board → Adapter manager** 注册 Hermes adapter
- 或在本地开发时通过 `~/.paperclip/adapter-plugins.json` 配置 `file:` 路径

### 3.1 重新 build adapter

```bash
cd /Users/neo/projects/hermes-paperclip-adapter
export PATH="$HOME/.bun/bin:$PATH"
npm run build
```

### 3.2 以本地插件方式接入 adapter

在 `~/.paperclip/adapter-plugins.json` 中为 Hermes adapter 配置本地 `file:` 路径，然后重启 Paperclip。

> 说明：当前这份产品化文档聚焦的是 **verify/demo 回归流程**；adapter 的具体插件注册步骤应以本仓库 `AGENTS.md` 的 plugin-only 说明为准。

### 3.3 重启 Paperclip

重启后再检查：

```bash
curl -sS "$PAPERCLIP_API_BASE/adapters"
```

---

## 4. 运行环境检测

### 推荐：直接运行一键验证

```bash
cd /Users/neo/projects/paperclip
pnpm hermes:verify
```

### 底层 API 等价命令

```bash
curl -sS -X POST \
  http://127.0.0.1:3100/api/companies/test-co/adapters/hermes_local/test-environment \
  -H 'Content-Type: application/json' \
  -d '{"adapterConfig":{}}'
```

本机当前预期结果：

- `status: "warn"` 或更好
- 不应再出现系统 `python3 3.9.6` 的误报

说明：

- 当前 adapter 已修正为优先读取 `hermes --version` 报告的 Python 版本
- 默认不再强制写死 `anthropic/claude-sonnet-4`
- 如果未显式指定 `model`，Paperclip 中的 Hermes agent 会回退到本机 Hermes 默认配置

---

## 5. 创建 company

如果还没有测试 company，可以用：

```bash
curl -sS -X POST http://127.0.0.1:3100/api/companies \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Hermes Paperclip Test Co",
    "description": "Temporary local company for Hermes adapter verification",
    "budgetMonthlyCents": 0
  }'
```

列出 company：

```bash
curl -sS http://127.0.0.1:3100/api/companies
```

---

## 6. 创建 Hermes agent

推荐最小配置：

- 不显式指定 `model`
- 不显式指定 `provider`
- 先给 `terminal,file`
- `persistSession` 先关掉，方便演示和排障

示例 payload 见：

- `doc/templates/hermes-local-agent.json`

其中 `paperclipApiUrl` 使用 `REPLACE_PAPERCLIP_API_BASE` 占位；在实际创建前请替换成当前实例的 API base（例如 `http://127.0.0.1:3100/api`）。

创建命令示例：

```bash
COMPANY_ID="<your-company-id>"

python - <<'PY' >/tmp/hermes-local-agent.filled.json
import json
from pathlib import Path
p = Path('/Users/neo/projects/paperclip/doc/templates/hermes-local-agent.json')
data = json.loads(p.read_text())
data['adapterConfig']['paperclipApiUrl'] = 'http://127.0.0.1:3100/api'
print(json.dumps(data))
PY

curl -sS -X POST "http://127.0.0.1:3100/api/companies/$COMPANY_ID/agents" \
  -H 'Content-Type: application/json' \
  --data @/tmp/hermes-local-agent.filled.json
```

列出 agent：

```bash
curl -sS "http://127.0.0.1:3100/api/companies/$COMPANY_ID/agents"
```

---

## 7. 下发 demo issue 给 Hermes agent

### 推荐：直接运行一键 demo

```bash
cd /Users/neo/projects/paperclip
pnpm hermes:demo
```

### 回归模式：复用已有 company / agent

```bash
cd /Users/neo/projects/paperclip
pnpm hermes:demo -- \
  --company-id <company-id> \
  --agent-id <agent-id> \
  --issue-title "Regression issue"
```

示例 payload 仍可参考：

- `doc/templates/hermes-demo-issue.json`

创建命令示例：

```bash
COMPANY_ID="<your-company-id>"
AGENT_ID="<your-agent-id>"

python - <<'PY'
import json
from pathlib import Path
p = Path('/Users/neo/projects/paperclip/doc/templates/hermes-demo-issue.json')
data = json.loads(p.read_text())
data['assigneeAgentId'] = 'REPLACE_AGENT_ID'
print(json.dumps(data))
PY
```

更直接的方式：把模板里的 `REPLACE_AGENT_ID` 替换掉后执行：

```bash
curl -sS -X POST "http://127.0.0.1:3100/api/companies/$COMPANY_ID/issues" \
  -H 'Content-Type: application/json' \
  --data @/path/to/hermes-demo-issue.filled.json
```

### 自动行为

当 issue 被分配给 agent 后，Paperclip 会自动：

- 把 issue 派给该 agent
- 触发 `assignment` 类型 wakeup
- 创建 heartbeat run
- 拉起 Hermes 执行

---

## 8. 观察运行结果

### 看 issue 列表

```bash
curl -sS "http://127.0.0.1:3100/api/companies/$COMPANY_ID/issues"
```

### 看某个 issue 详情

```bash
ISSUE_ID="<issue-id>"
curl -sS "http://127.0.0.1:3100/api/issues/$ISSUE_ID"
```

### 看 comments

```bash
curl -sS "http://127.0.0.1:3100/api/issues/$ISSUE_ID/comments"
```

### 看 heartbeat runs

```bash
curl -sS "http://127.0.0.1:3100/api/companies/$COMPANY_ID/heartbeat-runs?agentId=$AGENT_ID&limit=20"
```

### 看某次 run 的详情 / 事件 / 日志

```bash
RUN_ID="<run-id>"

curl -sS "http://127.0.0.1:3100/api/heartbeat-runs/$RUN_ID"
curl -sS "http://127.0.0.1:3100/api/heartbeat-runs/$RUN_ID/events"
curl -sS "http://127.0.0.1:3100/api/heartbeat-runs/$RUN_ID/log"
```

---

## 9. 本机已验证成功的 demo 闭环

本机已经实测成功的链路：

1. 创建测试 company
2. 创建 `hermes_local` agent
3. 创建并分配一个 issue 给该 agent
4. Paperclip 自动触发 assignment wakeup
5. Hermes 读取 issue 内容
6. Hermes 在 issue 下发评论（包含 `DEMO_DONE`）
7. Hermes 将 issue 状态改为 `done`
8. 对应 heartbeat run 最终 `status = succeeded`

回归模式下则是：

1. 复用已有 company
2. 复用已有 `hermes_local` agent
3. 创建并分配一个新的 regression issue
4. 观察同样的自动闭环是否继续成立

---

## 10. 配置建议

### 推荐默认项

- `toolsets: "terminal,file"`
- `timeoutSec: 120` 或 `300`
- `persistSession: false`（先演示再调优）
- **不要显式写 `model` / `provider`**，先继承本机 Hermes 默认配置
