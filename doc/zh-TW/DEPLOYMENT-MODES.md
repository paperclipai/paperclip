# 部署模式

狀態：規範部署和身份驗證模式模型
日期：2026-02-23

## 1. 目的

Paperclip 支援兩種運行模式：

1. `local_trusted`
2. `authenticated`

`authenticated` 支援兩種曝光策略：

1. `private`
2. `public`

這保留了一個經過身份驗證的身份驗證堆疊，同時仍將低摩擦專用網路預設設定與面向互聯網的強化要求分開。

## 2. 規範模型

|運行時模式 |曝光|人類授權|主要用途 |
|---|---|---|---|
| `local_trusted` |不適用 |無需登入 |單一操作員本機機器工作流程 |
| `authenticated` | `private` |需要登入 |專網存取（例如Tailscale/VPN/LAN）|
| `authenticated` | `public` |需登入 |面向網際網路/雲端部署 |

## 3. 安全性策略

## `local_trusted`

- 僅環回主機綁定
- 無需人工登入流程
- 針對最快的本地啟動進行了最佳化

## `authenticated + private`

- 需要登入
- 低摩擦 URL 處理（`auto` 基本 URL 模式）
- 需要私有主機信任策略

## `authenticated + public`

- 需要登入
- 需要明確的公開 URL
- 更嚴格的部署檢查和醫生的失敗

## 4. 入職使用者體驗合約

預設加入保持互動式且無標誌：

```sh
pnpm paperclipai onboard
```

伺服器提示行為：

1. 詢問模式，預設`local_trusted`
2. 選項複製：
- `local_trusted`：“最簡單的本機設定（無需登錄，僅限本機）”
- `authenticated`：“需要登入；用於專用網路或公共託管”
3. 如果是`authenticated`，詢問曝光：
- `private`：“專用網路存取（例如Tailscale），降低設定難度”
- `public`：“面向互聯網部署，安全要求更嚴格”
4. 僅針對 `authenticated + public` 詢問明確公開 URL

`configure --section server` 遵循相同的互動行為。

## 5. 博士使用者體驗合約

默認醫生保持無旗狀態：

```sh
pnpm paperclipai doctor
```

醫生讀取配置的模式/曝光並套用模式感知檢查。可選的覆蓋標誌是次要的。

## 6. 董事會/使用者整合合約

董事會身分必須由真實的資料庫使用者主體代表，以便基於使用者的功能能夠一致地運作。

所需的整合點：

- `authUsers` 中的真實用戶行用於董事會身份
- `instance_user_roles` 論壇管理員權限入口
- `company_memberships` 集成，用於用戶級任務分配和訪問

這是必要的，因為使用者指派路徑驗證 `assigneeUserId` 的活動成員資格。

## 7. 本地可信任 -> 經過驗證的宣告流程

執行 `authenticated` 模式時，如果唯一的實例管理員是 `local-board`，則 Paperclip 會發出帶有一次性高熵聲明 URL 的啟動警告。- 網址格式：`/board-claim/<token>?code=<code>`
- 預期用途：已登入的人類索賠委員會所有權
- 索賠行動：
  - 將目前登入使用者升級為`instance_admin`
  - 降級 `local-board` 管理員角色
  - 確保現有公司中聲明用戶的活躍所有者成員資格

當使用者從長期運行的本地可信任使用遷移到身份驗證模式時，這可以防止鎖定。

## 8. 當前程式碼現實（截至 2026-02-23）

- 運行時值為 `local_trusted | authenticated`
- `authenticated` 使用更好的身份驗證會話和引導邀請流程
- `local_trusted` 確保 `authUsers` 中真正的本地董事會使用者主體具有 `instance_user_roles` 管理員存取權限
- 公司創建確保創建者在 `company_memberships` 中的成員資格，以便用戶分配/訪問流程保持一致

## 9. 命名與相容性政策

- 規格命名為 `local_trusted` 和 `authenticated`，其中 `private/public` 曝光
- 沒有用於廢棄命名變體的長期相容性別名層

## 10. 與其他文件的關係

- 實施計畫：`doc/plans/deployment-auth-mode-consolidation.md`
- V1合約：`doc/SPEC-implementation.md`
- 操作員工作流程：`doc/DEVELOPING.md` 和 `doc/CLI.md`