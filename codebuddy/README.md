# CodeBuddy Fork 运维速查

> Paperclip 自身启动文档已很完整：`doc/05 开发指南 DEVELOPING.md`、`docs/项目计划/最佳实践/001-运维-回形针本地.md`。
> 本文只收 **fork 特有** 和 **日常高频** 的操作速查。

---

## 启动

```powershell
# 确保没有残留进程
pkill -f "paperclip"; pkill -f "tsx.*index.ts"

# 启动（NTFS 必须用 dev:once，tsx watch 会死锁）
pnpm dev:once
```

```powershell
# 健康检查
curl http://localhost:3100/api/health
```

---

## routic 公司速查


| 项目             | 值                                      |
| -------------- | -------------------------------------- |
| 公司 ID          | `cc098628-d91e-4e10-b4e4-000a6c822946` |
| Agent (Cursor) | `b064fe96`                             |
| 开发项目           | `001c415e`                             |


```powershell
# 一键探查脚本
pwsh -NoProfile -File "C:/Users/wuhen/工具优化/02-智能体-agents/03-Paperclip配置与向导/check-paperclip.ps1"

# 指定公司探查
pwsh -NoProfile -File "C:/Users/wuhen/工具优化/02-智能体-agents/03-Paperclip配置与向导/check-paperclip.ps1" -CompanyId cc098628-d91e-4e10-b4e4-000a6c822946
```

### 常用 API

```powershell
$BASE = "http://localhost:3100"
$CO = "cc098628-d91e-4e10-b4e4-000a6c822946"

# Agent 列表
curl -s "$BASE/api/companies/$CO/agents"

# Issue 列表
curl -s "$BASE/api/companies/$CO/issues"

# 活跃 Run
curl -s "$BASE/api/companies/$CO/live-runs"

# 某个 Issue 的 Run 历史
curl -s "$BASE/api/issues/{issueId}/runs"
```

---

## test-co 公司速查


| 项目    | 值                                            |
| ----- | -------------------------------------------- |
| 公司 ID | `b274a212-8add-4b6e-8e34-ff5ced668aa4`       |
| CEO   | `7cd1f6a5-ed41-4865-ad83-88dac0df7070`       |
| CTO   | `3a6d99f8-678a-42ce-ae7b-451fde61791a`       |
| Code  | `27017a20-93d7-4e73-b75a-ff5ced668aa4`       |
| 项目    | `fffb42da` → `C:\Users\wuhen\code\paperclip` |


---

## Agent 生命周期铁律

```
① 创建 issue（带 projectId + assigneeAgentId + executionWorkspaceId）
      ↓
② checkout issue → POST /api/issues/:id/checkout
      ↓
③ 启动 agent CLI 进程
      ↓
④ agent 通过 GET /heartbeat-runs?agentId= 主动轮询服务器拉 run
```

- Heartbeat 是 agent → 服务器轮询，不是服务器推送
- checkout 是原子操作，严禁手动改 issue status
- issue done 后必须同时关 run

---

## 进程泄漏检查

```powershell
# 查看所有 codebuddy 子进程
Get-Process -Name "codebuddy" -ErrorAction SilentlyContinue | 
    Select-Object Id, StartTime, @{N='CPU(s)';E={[math]::Round($_.CPU,1)}} |
    Sort-Object StartTime

# 只杀老进程（启动超过 10 分钟）
Get-Process 'CodeBuddy CN' -ErrorAction SilentlyContinue |
    Where-Object { $_.StartTime -lt (Get-Date).AddMinutes(-10) } |
    Stop-Process -Force
```

> 注意：`CodeBuddy CN` 包含 IDE 自身进程，不要通杀。按 PID 精确杀。

---

## 技能管理

```powershell
# 查看公司技能
curl -s "http://localhost:3100/api/companies/$CO/skills"

# 检查 symlink 注入
cmd /c "dir C:\Users\wuhen\.cursor\skills\"
```

---

## 数据库重置

```powershell
Remove-Item -Recurse -Force data/pglite
pnpm dev:once
```

---

## 参考

- Paperclip 开发手册：`doc/05 开发指南 DEVELOPING.md`
- 中文运维指南：`docs/项目计划/最佳实践/001-运维-回形针本地.md`
- 完整实践记录：`C:\Users\wuhen\工具优化\02-智能体-agents\03-Paperclip配置与向导\13.Paperclip 公司创建与项目配置实践记录.md`
- 进程泄漏需求：`C:\Users\wuhen\工具优化\02-智能体-agents\03-Paperclip配置与向导\CodeBuddy-CLI进程兜底回收机制.md`

