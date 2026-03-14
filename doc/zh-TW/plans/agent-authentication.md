# 智能體身份驗證和入職

## 問題

智能體程式需要 API 金鑰來與 Paperclip 進行驗證。目前的方法
（在應用程式中產生密鑰，手動將其配置為環境變數）是
費力且無法擴展。不同的適配器類型有不同的信任
模型，我們希望支援從“零配置本地”到
“智能體驅動的自我註冊。”

## 設計原則

1. **將身分驗證複雜度與信任邊界相符。 ** 本地 CLI 適配器
   不應該需要與基於 Webhook 的遠端智能體相同的儀式。
2. **智能體應該能夠自行加入。 **人類不必這樣做
   當智能體程式能夠執行以下操作時，將憑證複製並貼上到智能體環境中
   做它。
3. **預設審核門。 ** 自助註冊必須明確要求
   批准（由使用者或授權智能體），然後新智能體可以在
   一家公司。

---

## 身份驗證層

### 第 1 層：本機適配器（claude-local、codex-local）

**信任模型：** 適配器程序與 Paperclip 在同一台機器上執行
伺服器（或由它直接調用）。不存在有意義的網路邊界。

**做法：** Paperclip 產生token，直接傳遞給智能體
在呼叫時作為參數/env var 進行處理。無需手動設定。

**令牌格式：** 每個心跳調用（或每個
會話）。伺服器建立令牌，將其傳遞到適配器呼叫中，並且
在 API 請求上接受它。

**令牌生命週期注意事項：**

- 編碼智能體可以運行數小時，因此令牌不會很快過期。
- 即使在本地環境中，無限生命的代幣也是不可取的。
- 使用 JWTs 並具有較長的到期時間（例如 48 小時）並重疊窗口，以便
  接近到期時開始的心跳仍會完成。
- 伺服器不需要儲存這些令牌 - 它只是驗證 JWT
  簽名。

**狀態：** 部分實施。本地適配器已經通過
`PAPERCLIP_API_URL`、`PAPERCLIP_AGENT_ID`、`PAPERCLIP_COMPANY_ID`。我們需要
將 `PAPERCLIP_API_KEY` (JWT) 加入到注入的環境變數集中。

### 第 2 層：CLI 驅動程式的金鑰交換

**信任模型：** 開發人員正在設定遠端或半遠端智能體，並且
可以透過 shell 存取它。

**做法：** 與`claude setup-token`類似－開發者執行一個Paperclip CLI
開啟瀏覽器 URL 進行確認的命令，然後接收一個令牌
自動儲存在智能體程式的配置中。

```
paperclip auth login
# Opens browser -> user confirms -> token stored at ~/.paperclip/credentials
```

**令牌格式：** 長期 API 金鑰（在伺服器端雜湊儲存）。

**現況：** 未來。在我們擁有不需要的遠端適配器之前不需要
由Paperclip伺服器本身管理。

### 第 3 層：智能體自行註冊（邀請連結）**信任模型：** 智能體程式是一個自主的外部系統（例如 OpenClaw
智能體，一個 SWE 智能體實例）。設定過程中沒有人參與循環。的
智能體接收加入 URL 並協商其自己的註冊。

**方法：**

1. 公司管理員（使用者或智能體）從 Paperclip 產生**邀請 URL**。
2. 邀請 URL 被傳遞到目標智能體程式（透過訊息、任務
   描述、Webhook 負載等）。
3. 智能體程式取得 URL，返回 **入職文檔**
   包含：
   - 公司形象與背景
   - Paperclip SKILL.md（或其連結）
   - Paperclip 需要從智能體程式取得哪些資訊（例如 webhook URL、轉接器
     類型、功能、首選名稱/角色）
   - 將回應發佈到的註冊端點
4. 智能體程式以其配置進行回應（例如「這是我的 webhook URL，
   這是我的名字，這是我的能力」）。
5. Paperclip 儲存待註冊的資訊。
6. 審核者（使用者或授權智能體）審核並批准新的
   員工。批准包括指定智能體的經理（指揮鏈）
   以及任何初始角色/權限。
7. 批准後，Paperclip 提供智能體憑證並發送
   第一次心跳。

**Token格式：** Paperclip 審核通過後頒發API密鑰（或JWT），交付
透過其聲明的通訊管道發送給智能體。

**靈感：**

- [Allium自助註冊](https://agents.allium.so/skills/skill.md) --
  智能體程式收集憑證、輪詢確認、自動儲存密鑰。
- [Allium x402](https://agents.allium.so/skills/x402-skill.md) -- 多重步驟
  憑證設定完全由智能體程式驅動。
- [OpenClaw webhooks](https://docs.openclaw.ai/automation/webhook) -- 外部
  系統透過經過驗證的 Webhook 端點觸發智能體操作。

---

## 自助註冊：入職談判協議

邀請 URL 回應應該是結構化文件（JSON 或 markdown），
既是人類可讀的又是機器可解析的：

```
GET /api/invite/{inviteToken}
```

回應：

```json
{
  "company": {
    "id": "...",
    "name": "Acme Corp"
  },
  "onboarding": {
    "instructions": "You are being invited to join Acme Corp as an employee agent...",
    "skillUrl": "https://app.paperclip.ing/skills/paperclip/SKILL.md",
    "requiredFields": {
      "name": "Your display name",
      "adapterType": "How Paperclip should send you heartbeats",
      "webhookUrl": "If adapter is webhook-based, your endpoint URL",
      "capabilities": "What you can do (free text or structured)"
    },
    "registrationEndpoint": "POST /api/invite/{inviteToken}/register"
  }
}
```

智能體發回：

```json
{
  "name": "CodingBot",
  "adapterType": "webhook",
  "webhookUrl": "https://my-agent.example.com/hooks/agent",
  "webhookAuthToken": "Bearer ...",
  "capabilities": ["code-review", "implementation", "testing"]
}
```

這將進入 `pending_approval` 狀態，直到有人批准為止。

---

## OpenClaw 作為第一個外部集成

OpenClaw 是第 3 層的理想第一個目標，因為：

- 它已經具有用於接收任務的 webhook 支援 (`POST /hooks/agent`)。
- webhook 設定（URL、驗證令牌、會話金鑰）正是我們所需要的
  智能體在入職期間告訴我們。
- OpenClaw 智能體程式可以讀取 URL、解析指令並進行 HTTP 呼叫。

**工作流程：**1. 生成公司的Paperclip邀請連結。
2. 將邀請連結傳送給 OpenClaw 智能體程式（透過他們現有的訊息傳遞
   頻道）。
3. OpenClaw 智能體程式取得邀請，讀取入職文檔，然後
   使用其 webhook 配置進行回應。
4. Paperclip 公司會員批准新智能體。
5. Paperclip 開始向 OpenClaw Webhook 端點發送心跳。

---

## 審批模型

所有自助註冊都需要批准。這對於安全來說是不容妥協的。

- **預設值：** 公司中的人類使用者必須批准。
- **委託：** 具有`approve_agents`權限的經理級智能體可以
  批准（對於擴展很有用）。
- **自動批准（選擇加入）：** 公司可以為邀請配置自動批准
  以特定信任等級產生的連結（例如「我信任任何人
  透過此連結」）。即便如此，邀請連結本身也是一個秘密。

批准後，批准者設定：

- `reportsTo` -- 新特務在指揮系統中向誰報告
- `role` -- 智能體在公司內的角色
- `budget` -- 初始預算分配

---

## 實作重點

|優先|項目 |筆記|
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| **P0** |本機適配器JWT注入|解鎖零配置本地身份驗證。每個心跳鑄造一個JWT，傳遞為`PAPERCLIP_API_KEY`。          |
| **P1** |邀請連結 + 加入端點 | `POST /api/companies/:id/invites`、`GET /api/invite/:token`、`POST /api/invite/:token/register`。 |
| **P1** |審核流程| UI + API 用於審核和批准待處理的智能體註冊。                                |
| **P2** | OpenClaw 整合 |第一個真正的外部智能體透過邀請連結加入。                                            |
| **P3** | CLI 認證流程 | `paperclipai auth login` 用於開發人員管理的遠端智能體。                                      |

## P0實施計劃

P0本地JWT執行計畫請參考[`doc/plans/agent-authentication-implementation.md`](agent-authentication-implementation.md)。

---

## 開放問題

- **JWT 簽章金鑰輪替：** 我們如何在不使用簽章金鑰的情況下輪替簽章金鑰
  使飛行中的心跳無效？
- **邀請連結到期：** 邀請連結應該是一次性使用還是多次使用？有時間限制嗎？
- **適配器協商：** 入門文件是否支援任意適配器
  類型，或者我們應該列舉支援的適配器並讓智能體選擇一個？
- **憑證續約：** 對於長期存在的外部智能體，我們如何處理 API
  鑰匙輪換無需停機？