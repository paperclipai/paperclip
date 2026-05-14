# 探查：Board **ROU-20** 运行记录（中英混排任务）

## 数据来源

- **环境**：本机 Paperclip `local_trusted`，`GET http://127.0.0.1:3100/api/...`（无需 Board Cookie）。  
- **工单**：`GET /api/issues/ROU-20`  
- **运行列表**：`GET /api/issues/ROU-20/runs`  
- **单条详情**：`GET /api/heartbeat-runs/{runId}`（核对 `error` / `errorCode` / `retryOfRunId` / `processLossRetryCount`）。  
- **整理入档**：2026-05-14（与 API 中 `createdAt` 同日数据一致）。

## 工单快照（整理时）

| 字段 | 值 |
|------|-----|
| `identifier` | `ROU-20` |
| `id`（UUID） | `9b30398c-6677-4321-8586-104124f4ea0a` |
| `companyId` | `cc098628-d91e-4e10-b4e4-000a6c822946`（routic） |
| `status` | `done` |
| `assigneeAgentId` | `b064fe96-df64-434c-ace3-607674991330`（**开发-Cursor-composer2fast**，`cursor`） |
| `executionRunId` | `null`（执行锁已释放） |
| 标题摘要 | 控制台任务中英混排探查（与仓库 **T-010** / `探查-控制台任务中英混排.md` 对应） |

## 运行记录表（按时间从早到晚）

与 `GET /api/issues/ROU-20/runs` 返回顺序相反，下列按 **`createdAt` 升序** 叙述。

| # | `runId` | Agent | `invocationSource` | `contextSnapshot.wakeReason`（或等价） | 终态 | `errorCode` / 摘要 |
|---|---------|--------|-------------------|----------------------------------------|------|-------------------|
| 1 | `fa42f79f-be80-43ec-a698-ec1343f85a14` | **CEO**（`2543471f-454b-4b3c-98eb-9398130af314`，`codebuddy_local`） | `assignment` | `issue_assigned` | `failed` | **`adapter_failed`** — `Adapter failed` |
| 2 | `1e367944-0d9f-4a6a-9216-8426d889ac33` | **开发-Cursor**（`b064fe96-…`，`cursor`） | `assignment` | `issue_assigned` | `failed` | **`process_lost`** — 子 pid 已退出；文案含 *retrying once*；`processLossRetryCount: 0` |
| 3 | `82eecc3c-c0b2-43a5-9db0-460199c81e91` | **开发-Cursor** | `automation` | **`process_lost_retry`** | `failed` | **`process_lost`** — `retryOfRunId` = `1e367944-…`，`processLossRetryCount: 1`（自动重试耗尽后仍丢进程） |
| 4 | `0607fc70-43b2-4007-905d-aafbf09a9b06` | **开发-Cursor** | `automation` | `issue_reopened_via_comment` | `failed` | **`process_lost`** — *retrying once*；`processLossRetryCount: 0` |
| 5 | `f7f3c17d-8641-41d3-8098-a7424ddf7f77` | **开发-Cursor** | `automation` | **`process_lost_retry`** | `failed` | **`process_lost`** — `retryOfRunId` = `0607fc70-…`，`processLossRetryCount: 1` |
| 6 | `f3a91ccf-ad66-4a19-8ec6-42eedd186f87` | **开发-Cursor** | `automation` | `issue_commented` | `cancelled` | **`cancelled`** — `Cancelled due to agent pause`（与 `process_lost` 不同类） |

## 结论（与 `process_lost_retry` 探查文档交叉）

- 同一工单上出现 **两条** `wakeReason === "process_lost_retry"` 的 run（`82eecc3c…`、`f7f3c17d…`），对应 **两条独立原 run**（`1e367944…`、`0607fc70…`）各自触发 **「最多一次」** 自动重试，**不是**单链上重复排队多次。详见 `探查-process_lost_retry.md`。  
- **首条 run** 为 CEO **CodeBuddy** `adapter_failed`，随后工单由 Board 改派 **Cursor** 继续，后续失败主要为 **本地子进程丢失**（`process_lost`）及一次自动重试后再丢。  
- 最后一条 **`issue_commented`** 唤醒被取消，原因为 **agent 处于 pause**，需在 Board 上对照当时 **开发-Cursor** 是否被暂停。

## 复现拉数（备忘）

```http
GET http://127.0.0.1:3100/api/issues/ROU-20
GET http://127.0.0.1:3100/api/issues/ROU-20/runs
GET http://127.0.0.1:3100/api/heartbeat-runs/{runId}
```

（生产 / `authenticated` 模式需 Board 会话或合法凭证，本表为 **local_trusted** 快照。）
