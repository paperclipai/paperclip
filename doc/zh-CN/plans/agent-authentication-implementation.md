# 智能体身份验证 — P0 本地适配器 JWT 实现

## 范围

- 范围内适配器：`claude_local`、`codex_local`。
- 目标：本地适配器的零配置身份验证，同时保留所有其他调用路径的静态密钥。
- 超出 P0 范围：轮换 UX、每设备撤销列表和 CLI 加入。

## 1) 令牌格式和配置

- 使用 HS256 JWT 并声明：
  - `sub`（智能体 ID）
  - `company_id`
  - `adapter_type`
  - `run_id`
  - `iat`
  - `exp`
  - 可选`jti`（运行令牌id）
- 新的配置/环境设置：
  - `PAPERCLIP_AGENT_JWT_SECRET`
  - `PAPERCLIP_AGENT_JWT_TTL_SECONDS`（默认：`172800`）
  - `PAPERCLIP_AGENT_JWT_ISSUER`（默认：`paperclip`）
  - `PAPERCLIP_AGENT_JWT_AUDIENCE`（默认：`paperclip-api`）

## 2) `actorMiddleware` 中的双重认证路径

1. 保持现有的数据库键查找路径不变（`agent_api_keys` 哈希查找）。
2. 如果没有DB key匹配，则在`server/src/middleware/auth.ts`中添加JWT验证。
3. 关于JWT成功：
   - 设置 `req.actor = { type: "agent", agentId, companyId }`。
   - 可选择防止终止智能体。
4. 继续对没有有效身份验证的请求进行董事会回退。

## 3) 选择加入适配器功能

1. 使用功能标志扩展 `ServerAdapterModule`（可能是 `packages/adapter-utils/src/types.ts`）：
   - `supportsLocalAgentJwt?: true`。
2. 启用它：
   - `server/src/adapters/registry.ts` 为 `claude_local` 和 `codex_local`。
3. 保持 P0 的 `process`/`http` 适配器未设置。
4. 在`server/src/services/heartbeat.ts`中，当适配器支持JWT时：
   - 在执行之前每个心跳运行薄荷JWT。
   - 在适配器执行上下文中包含令牌。

## 4) 本地环境注入行为

1. 在：
   - `packages/adapters/claude-local/src/server/execute.ts`
   - `packages/adapters/codex-local/src/server/execute.ts`

   从上下文令牌注入 `PAPERCLIP_API_KEY`。

- 保留 `adapterConfig.env` 中显式用户定义环境变量的现有行为：
  - 如果用户已经设置了`PAPERCLIP_API_KEY`，请勿覆盖它。
- 继续注射：
  - `PAPERCLIP_AGENT_ID`
  - `PAPERCLIP_COMPANY_ID`
  - `PAPERCLIP_API_URL`

## 5) 文档更新

- 更新面向操作员的文档以消除本地适配器的手动密钥设置期望：
  - `skills/paperclip/SKILL.md`
  - `cli/src/commands/heartbeat-run.ts` 输出/帮助示例（如果提及手动 API 密钥设置）。

## 6) P0 验收标准

- 本地适配器无需手动 `PAPERCLIP_API_KEY` 配置即可进行身份验证。
- 现有的静态密钥（`agent_api_keys`）仍然保持不变。
- 身份验证仍属于公司范围（现有检查使用 `req.actor.companyId`）。
- JWT 生成和验证错误被记录为非泄漏结构化事件。
- 范围仍然仅限本地（`claude_local`、`codex_local`），而适配器功能模型是通用的。