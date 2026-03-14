使用這個精確的清單。

1. 以認證模式啟動Paperclip。
```bash
cd <paperclip-repo-root>
pnpm dev --tailscale-auth
```
然後驗證：
```bash
curl -sS http://127.0.0.1:3100/api/health | jq
```

2. 啟動清理/庫存 OpenClaw Docker。
```bash
OPENCLAW_RESET_STATE=1 OPENCLAW_BUILD=1 ./scripts/smoke/openclaw-docker-ui.sh
```
在瀏覽器中開啟列印的`Dashboard URL`（包括`#token=...`）。

3. 在Paperclip介面，進入`http://127.0.0.1:3100/CLA/company/settings`。

4. 使用OpenClaw邀請提示流程。
- 在「邀請」部分中，按一下「`Generate OpenClaw Invite Prompt`」。
- 從 `OpenClaw Invite Prompt` 複製產生的提示。
- 將其作為一條訊息貼到 OpenClaw 主聊天中。
- 如果停止，請發送一封後續郵件：`How is onboarding going? Continue setup now.`

安全/控制說明：
- OpenClaw 邀請提示是從受控端點建立的：
  - `POST /api/companies/{companyId}/openclaw/invite-prompt`
  - 擁有邀請權限的board使用者可以調用
  - 智能體來電者僅限於公司CEO 智能體

5. 在 Paperclip UI 中核准加入請求，然後確認 OpenClaw 智能體程式出現在 CLA 智能體程式中。

6. 網關預檢（任務測試前需要）。
- 確認創建的智能體使用`openclaw_gateway`（不是`openclaw`）。
- 確認閘道URL為`ws://...`或`wss://...`。
- 確認網關令牌非常重要（非空/非 1 字元佔位符）。
- OpenClaw 閘道適配器 UI 不應公開 `disableDeviceAuth` 進行正常登入。
- 確認配對模式是明確的：
  - 必要的預設值：啟用裝置驗證（`adapterConfig.disableDeviceAuth` 錯誤/不存在）並保留 `adapterConfig.devicePrivateKeyPem`
  - 不要依賴 `disableDeviceAuth` 進行正常入職
- 如果您可以使用板授權執行 API 檢查：
```bash
AGENT_ID="<newly-created-agent-id>"
curl -sS -H "Cookie: $PAPERCLIP_COOKIE" "http://127.0.0.1:3100/api/agents/$AGENT_ID" | jq '{adapterType,adapterConfig:{url:.adapterConfig.url,tokenLen:(.adapterConfig.headers["x-openclaw-token"] // .adapterConfig.headers["x-openclaw-auth"] // "" | length),disableDeviceAuth:(.adapterConfig.disableDeviceAuth // false),hasDeviceKey:(.adapterConfig.devicePrivateKeyPem // "" | length > 0)}}'
```
- 預計：`adapterType=openclaw_gateway`、`tokenLen >= 16`、`hasDeviceKey=true` 和 `disableDeviceAuth=false`。

配對握手注意事項：
- 乾淨運行期望：第一個任務應該成功，無需手動配對命令。
- 適配器嘗試一次自動配對批准 + 在第一個 `pairing required` 上重試（當共用網關驗證令牌/密碼有效時）。
- 如果自動配對無法完成（例如令牌不符或沒有待處理的請求），第一次網關運行可能仍會傳回 `pairing required`。
- 這是與 Paperclip 邀請批准分開的批准。您必須在 OpenClaw 本身中核准待處理的設備。
- 在OpenClaw中批准它，然後重試該任務。
- 對於本機 docker Smoke，您可以從主機批准：
```bash
docker exec openclaw-docker-openclaw-gateway-1 sh -lc 'openclaw devices approve --latest --json --url "ws://127.0.0.1:18789" --token "$(node -p \"require(process.env.HOME+\\\"/.openclaw/openclaw.json\\\").gateway.auth.token\")"'
```
- 您可以檢查待處理設備與已配對設備：
```bash
docker exec openclaw-docker-openclaw-gateway-1 sh -lc 'TOK="$(node -e \"const fs=require(\\\"fs\\\");const c=JSON.parse(fs.readFileSync(\\\"/home/node/.openclaw/openclaw.json\\\",\\\"utf8\\\"));process.stdout.write(c.gateway?.auth?.token||\\\"\\\");\")\"; openclaw devices list --json --url \"ws://127.0.0.1:18789\" --token \"$TOK\"'
```

7. 案例A（手動發布測試）。
- 建立指派給 OpenClaw 智能體程式的問題。
- 放置說明：“發表評論 `OPENCLAW_CASE_A_OK_<timestamp>` 並標記為完成。”
- 在 UI 中驗證：問題狀態變成 `done` 並且評論存在。

8. 案例B（訊息工具測試）。
- 建立另一個指派給 OpenClaw 的問題。
- 說明：“透過訊息工具發送 `OPENCLAW_CASE_B_OK_<timestamp>` 到主網路聊天，然後在問題上評論相同的標記，然後標記為完成。”
- 驗證兩者：
  - 對問題的標記評論
  - 標記文字出現在 OpenClaw 主聊天中9. 個案 C（新會話記憶/技能測驗）。
- 在OpenClaw中，啟動`/new`會話。
- 要求它在 Paperclip 中建立一個新的 CLA 問題，其唯一標題為 `OPENCLAW_CASE_C_CREATED_<timestamp>`。
- 在 Paperclip UI 中驗證是否有新問題。

10. 在測試期間觀察日誌（可選但有幫助）：
```bash
docker compose -f /tmp/openclaw-docker/docker-compose.yml -f /tmp/openclaw-docker/.paperclip-openclaw.override.yml logs -f openclaw-gateway
```

11. 預期通過標準。
- 預檢：`openclaw_gateway` + 非佔位符令牌 (`tokenLen >= 16`)。
- 配對模式：穩定的 `devicePrivateKeyPem` 配置為啟用裝置驗證（預設路徑）。
- 案例 A：`done` + 標記註記。
- 案例B：`done` + 標記評論 + 主聊天訊息可見。
- 案例 C：原始任務完成並從 `/new` 會話建立新問題。

如果您願意，我還可以為您提供一個「觀察者模式」命令，該命令可以在您在 UI 中即時觀看相同步驟時運行庫存排煙裝置。