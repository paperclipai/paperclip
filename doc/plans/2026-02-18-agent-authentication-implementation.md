# 智能体认证 — P0 本地适配器 JWT 实现

## 范围

- 范围内适配器：`claude_local`、`codex_local`。
- 目标：为本地适配器实现零配置认证，同时为所有其他调用路径保留静态密钥。
- P0 范围外：轮换 UX、每设备撤销列表和 CLI 入门。

## 1) Token 格式和配置

- 使用 HS256 JWT，包含声明：
  - `sub`（智能体 id）
  - `company_id`
  - `adapter_type`
  - `run_id`
  - `iat`
  - `exp`
  - 可选 `jti`（运行 Token id）
- 新的配置/环境设置：
  - `PAPERCLIP_AGENT_JWT_SECRET`
  - `PAPERCLIP_AGENT_JWT_TTL_SECONDS`（默认：`172800`）
  - `PAPERCLIP_AGENT_JWT_ISSUER`（默认：`paperclip`）
  - `PAPERCLIP_AGENT_JWT_AUDIENCE`（默认：`paperclip-api`）

## 2) `actorMiddleware` 中的双重认证路径

1. 保持现有的数据库密钥查找路径不变（`agent_api_keys` 哈希查找）。
2. 如果没有数据库密钥匹配，在 `server/src/middleware/auth.ts` 中添加 JWT 验证。
3. JWT 成功时：
   - 设置 `req.actor = { type: "agent", agentId, companyId }`。
   - 可选地检查已终止的智能体。
4. 对没有有效认证的请求继续董事会回退。

## 3) 选择加入的适配器能力

1. 在 `ServerAdapterModule`（可能是 `packages/adapter-utils/src/types.ts`）中扩展能力标志：
   - `supportsLocalAgentJwt?: true`。
2. 在以下位置启用：
   - `server/src/adapters/registry.ts` 中的 `claude_local` 和 `codex_local`。
3. P0 阶段保持 `process`/`http` 适配器未设置。
4. 在 `server/src/services/heartbeat.ts` 中，当适配器支持 JWT 时：
   - 在执行前为每次心跳运行铸造 JWT。
   - 在适配器执行上下文中包含 Token。

## 4) 本地环境注入行为

1. 在以下文件中：
   - `packages/adapters/claude-local/src/server/execute.ts`
   - `packages/adapters/codex-local/src/server/execute.ts`

   从上下文 Token 注入 `PAPERCLIP_API_KEY`。

- 保留用户在 `adapterConfig.env` 中定义的现有环境变量行为：
  - 如果用户已设置 `PAPERCLIP_API_KEY`，不覆盖它。
- 继续注入：
  - `PAPERCLIP_AGENT_ID`
  - `PAPERCLIP_COMPANY_ID`
  - `PAPERCLIP_API_URL`

## 5) 文档更新

- 更新面向运营者的文档，移除本地适配器的手动密钥设置预期：
  - `skills/paperclip/SKILL.md`
  - `cli/src/commands/heartbeat-run.ts` 输出/帮助示例（如果提到手动 API 密钥设置）。

## 6) P0 验收标准

- 本地适配器无需手动 `PAPERCLIP_API_KEY` 配置即可认证。
- 现有静态密钥（`agent_api_keys`）仍然不变地工作。
- 认证保持公司范围（`req.actor.companyId` 由现有检查使用）。
- JWT 生成和验证错误作为不泄露的结构化事件记录。
- 范围保持仅限本地（`claude_local`、`codex_local`），而适配器能力模型是通用的。
