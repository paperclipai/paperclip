# 智能體身份驗證 — P0 本機適配器 JWT 實現

## 范围

- 範圍內適配器：`claude_local`、`codex_local`。
- 目標：本機適配器的零配置驗證，同時保留所有其他呼叫路徑的靜態金鑰。
- 超出 P0 範圍：輪換 UX、每設備撤銷清單和 CLI 加入。

## 1) 令牌格式和配置

- 使用 HS256 JWT 并声明：
  - `sub`（智能體 ID）
  - `company_id`
  - `adapter_type`
  - `run_id`
  - `iat`
  - `exp`
  - 可選`jti`（運行令牌id）
- 新的配置/環境設定：
  - `PAPERCLIP_AGENT_JWT_SECRET`
  - `PAPERCLIP_AGENT_JWT_TTL_SECONDS`（預設：`172800`）
  - `PAPERCLIP_AGENT_JWT_ISSUER`（默认：`paperclip`）
  - `PAPERCLIP_AGENT_JWT_AUDIENCE`（預設：`paperclip-api`）

## 2) `actorMiddleware` 中的雙認證路徑

1. 保持現有的資料庫鍵查找路徑不變（`agent_api_keys` 哈希查找）。
2. 如果沒有DB key匹配，則在`server/src/middleware/auth.ts`中加入JWT驗證。
3. 关于JWT成功：
   - 設定 `req.actor = { type: "agent", agentId, companyId }`。
   - 可選擇防止終止智能體程式。
4. 繼續對沒有有效身分驗證的請求進行董事會回退。

## 3) 選擇加入轉接器功能

1. 使用功能標誌擴充 `ServerAdapterModule`（可能是 `packages/adapter-utils/src/types.ts`）：
   - `supportsLocalAgentJwt?: true`。
2. 启用它：
   - `server/src/adapters/registry.ts` 為 `claude_local` 和 `codex_local`。
3. 保持 P0 的 `process`/`http` 轉接器未設定。
4. 在`server/src/services/heartbeat.ts`中，當適配器支援JWT時：
   - 在執行之前每個心跳運行薄荷JWT。
   - 在适配器执行上下文中包含令牌。

## 4) 本地环境注入行为

1. 在：
   - `packages/adapters/claude-local/src/server/execute.ts`
   - `packages/adapters/codex-local/src/server/execute.ts`

   從上下文令牌注入 `PAPERCLIP_API_KEY`。

- 保留 `adapterConfig.env` 中明確使用者定義環境變數的現有行為：
  - 如果使用者已經設定了`PAPERCLIP_API_KEY`，請勿覆寫它。
- 继续注射：
  - `PAPERCLIP_AGENT_ID`
  - `PAPERCLIP_COMPANY_ID`
  - `PAPERCLIP_API_URL`

## 5) 文档更新

- 更新面向操作員的文件以消除本機適配器的手動金鑰設定期望：
  - `skills/paperclip/SKILL.md`
  - `cli/src/commands/heartbeat-run.ts` 輸出/幫助範例（如果提及手動 API 金鑰設定）。

## 6) P0 验收标准

- 本機適配器無需手動 `PAPERCLIP_API_KEY` 配置即可進行身份驗證。
- 現有的靜態金鑰（`agent_api_keys`）仍保持不變。
- 驗證仍屬於公司範圍（現有檢查使用 `req.actor.companyId`）。
- JWT 產生和驗證錯誤被記錄為非洩漏結構化事件。
- 範圍仍然僅限本地（`claude_local`、`codex_local`），而適配器功能模型是通用的。