# 实践：从 Postgres 核查公司与智能体

**用途：** 不启动 Paperclip API、不等 UI，直接确认**某家公司是否在库里、有多少 agent、`adapter_type` / `adapter_config` / 暂停与心搏**等。与文档互相独立——**以 DB 行为准**，文档可当索引。

**前置：** 本机或 Compose 里的 Postgres **可连**；已知或使用下文方式解析 **`DATABASE_URL`**。

---

## 1. 拿到 `DATABASE_URL`（按优先级试）

1. **当前 shell 已导出** `DATABASE_URL`（例如 CI、你已 `set` 过）。
2. **仓库根** `.env` 里的 `DATABASE_URL=`（日常开发常见；见 **[`001-运维-回形针本地.md`](001-运维-回形针本地.md)** 与 **`paperclip-environment`** 规则）。
3. **默认实例目录** `%USERPROFILE%\.paperclip\instances\default\.env`（桌面实例、未在仓库根落库时常用）。

解析规则：忽略空行与 `#` 注释；值两端可有引号，读入后去掉。

> 若三项都没有或连不上，先去起 **`docker compose … db`** 或核对 **[`.env.example`](../../../.env.example)**，不要假定端口一定是 `3100` / `5432`——以你当前 compose 映射为准。

### 1.1 Paperclip **服务进程**什么时候会「没带」数据库地址？

说的是 **Node 里最终没有有效 `DATABASE_URL`**，于是会退回到**内嵌 Postgres**（日志里常见一句 *no DATABASE_URL set / embedded*）。**不是**你在 PowerShell 里 `echo` 空不空——很多情况是文件里有，但**进程没加载到**。

**常见原因（人话）：**

- **三处都没写**：仓库根 `.env`、实例目录 `.env`、系统环境变量都没有。
- **起服务的方式太「干净」**：计划任务、随便一个包装脚本起 `node`，**没帮你灌 `.env`**。
- **工作目录 / 配置路径不对**：从奇怪 `cwd` 起 `pnpm`，没扫到你放 `DATABASE_URL` 的那份 `.env`；或 **`PAPERCLIP_CONFIG`** 指到别的实例，加载顺序和你想的不一致。
- **写了白写**：变量名打错、整行被注释、格式错误没解析进去。

**你怎么验收：** 看**启动日志**——只要还在说「用内嵌库」，当次就相当于「地址没带成功」。链路细节仍以 **`server/src/config.ts`** 与 **[`001-运维-回形针本地.md`](001-运维-回形针本地.md)**（环境与 `.env`）为准。

### 1.2 API Key 和「内嵌 / 容器」是啥关系？

智能体 Key、看板 Key 在库里是 **`agent_api_keys` / `board_api_keys` 这类表**，**跟你连的是同一颗 Postgres**。连容器就落在容器里校验；某次误连内嵌就落在内嵌里——**没有第二套专门绑内嵌的授权库**。  
所以：**删内嵌数据目录不会删掉容器里的 Key**；但若曾经只在「误连内嵌」时建过 Key、又没迁库，删内嵌会把那份 Key 一起带走。

---

## 2. 连库方式（任选）

- **`psql`**：`psql "$DATABASE_URL" -c '…'`（本机已装且 PATH 里有）。
- **任意 Postgres 客户端**：DBeaver、pgAdmin、IDE 插件，贴同一连接串即可。
- **临时代码**：仓库 **`packages/db`** 依赖 **`postgres`**（js），可写一次性 `.mjs`：`import postgres from "postgres"`，读入 URL 后 `await sql\`…\``，用完 `await sql.end()`。不必启动 `server/`。

---

## 3. 该查哪些表、哪些列

| 表 | 常用列 | 说明 |
| --- | --- | --- |
| **`companies`** | `id`, `name`, `issue_prefix` | 公司主键；**`issue_prefix` 常比 `name` 更稳**（同名、历史公司容易混）。 |
| **`agents`** | `company_id`, `id`, `name`, `role`, `status`, `adapter_type`, `adapter_config`, `runtime_config`, `paused_at`, `pause_reason` | **执行平面真值**在 `adapter_config`（如 `command`、`model`、`cwd`、`env`）；心搏在 `runtime_config.heartbeat`。 |

**按公司拉全量 agent 示例 SQL**（把 `公司 id` 换成你的 `companies.id`）：

```sql
SELECT id, name, role, title, status, adapter_type, paused_at, pause_reason,
       adapter_config, runtime_config
FROM agents
WHERE company_id = 'cc098628-d91e-4e10-b4e4-000a6c822946'
ORDER BY name;
```

**按前缀找公司**（适合 routic 一类）：

```sql
SELECT id, name, issue_prefix FROM companies
WHERE name ILIKE '%routic%' OR issue_prefix IN ('ROU', 'ROUA')
ORDER BY name;
```

若出现**多家同名或相似名**：以 `issue_prefix` + **agent 数量是否为 0** 区分空壳公司；正式环境 often 一条主数据、一条废弃/测试。

---

## 4. 读完之后怎么下结论（短检查单）

- **`adapter_type`** 是否与预期一致（`cursor`、`qwen_local`、`codebuddy_local` 等）。
- **`adapter_config.command` / `model`** 是否与文档或 Board 展示一致。
- **`status` + `paused_at` + `pause_reason`**：手工 `paused` 时，心搏开着也**不会**替你执行。
- **`adapter_config.env`**：常有 **API Key**——**禁止**原样贴进协作聊天、纪要、截图；对外只写「已配置 / 未配置」或脱敏后四位。

---

## 5. 与「容器」的关系

本仓库约定日常开发常用 **Docker 仅起 Postgres 容器**，API 在宿主跑；此时 **`DATABASE_URL` 指向该容器映射端口** 即可，**不必**把 Paperclip 放进容器才查库。

若整栈在 **Compose `container-server`** 等 profile 里跑，**仍是同一个 Postgres 实例**（连接串换成容器网络内主机名/端口）。方法论不变：**能连上 `DATABASE_URL` 指向的那颗库即可**。

---

## 6. 文书纪律

本文只描述**怎么查**；某公司的 agent 清单与 ID **以你实例当前 DB 为准**。协作索引可继续用 **`docs/项目计划/执行/`** 里的任务单，发现与 DB 不一致时在任务单或探查里记一笔差异原因。

---

**下一动作：** 需要自动化时，可把读 `.env` + 打印 `agents` 提成 **`scripts/`** 下受控脚本（注意不要提交含真实 URL 的输出）；验收仍以本机连库与脱敏为准。
