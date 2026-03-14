# 部署/驗證模式整合計劃

狀態：提案
擁有者：伺服器+CLI+UI
日期：2026-02-23

## 目標

保持 Paperclip 低摩擦，同时使模式模型更简单、更安全：

1. `local_trusted` 仍然是默认且最简单的路径。
2、一種認證運作模式，支援私網本地使用和公有雲使用。
3. 入职/配置/医生保持主要互动且无标志。
4. 董事会身份由数据库中的真实用户行表示，具有明确的角色/成员资格集成点。

## 產品限制（來自評論）

1. `onboard` 預設流程是互動的（不需要標誌）。
2. 第一個模式選擇預設為`local_trusted`，具有清晰的UX副本。
3. 經過身分驗證的流程為私人曝光與公開曝光提供了指導。
4. `doctor` 預設情況下也應該是無標誌的（讀取配置並評估所選模式/設定檔）。
5. 不要为废弃的模式名称添加向后兼容的别名层。
6. 計畫必須明確涵蓋使用者/董事會在資料庫中的表示方式以及這如何影響任務分配和權限。

## 当前实施审计（截至 2026 年 2 月 23 日）

## 運行時/驗證

- 運行時部署模式目前為 `local_trusted | cloud_hosted` (`packages/shared/src/constants.ts`)。
- `local_trusted` 演員目前已合成：
  - `req.actor = { type: "board", userId: "local-board", source: "local_implicit" }` (`server/src/middleware/auth.ts`)。
  - 預設情況下，這不是真正的身份驗證用戶行。
- `cloud_hosted` 使用更好的身份验证会话和 `authUsers` 行（`server/src/auth/better-auth.ts`、`packages/db/src/schema/auth.ts`）。

## 引導/管理

- `cloud_hosted` 需要 `BETTER_AUTH_SECRET` 并从 `instance_user_roles`（`server/src/index.ts`、`server/src/routes/health.ts`）报告引导状态。
- 引導程式邀請接受將登入使用者提升為 `instance_admin`（`server/src/routes/access.ts`、`server/src/services/access.ts`）。

## 成員資格/任務集成

- 使用者任務分配需要該使用者的活動 `company_memberships` 條目 (`server/src/services/issues.ts`)。
- 本地隱性董事會身分不會自動成為真正的會員主體；這是「董事會作為可分配使用者」語意的差距。

## 建議的運行時模型

## 模式

1. `local_trusted`
- 無需登入
- 僅本機/環回
- 針對單一操作員本地設定進行了最佳化

2. `authenticated`
- 人類行為需要登入
- 私有和公用部署使用相同的身份驗證堆疊

## 暴露政策（`authenticated` 內）

1. `private`
- 专用网络部署（LAN、VPN、Tailscale）
- 低摩擦 URL 處理（`auto` 基本 URL）
- 嚴格的主機允許私人目標的政策

2. `public`
- 面向互聯網的部署
- 需要明確的公開基礎 URL
- 醫生更嚴格的部署檢查

這是一種具有兩種安全性原則的身份驗證模式，而不是兩種不同的身份驗證系統。

## 使用者體驗合約

## Onboard（主要路徑：互動式）

預設命令保持不變：

```sh
pnpm paperclipai onboard
```

互動伺服器步驟：1.詢問方式預設選擇`local_trusted`
2. 複製選項：
- `local_trusted`：“最簡單的本機設定（無需登錄，僅限本機）”
- `authenticated`：“需要登入；用於專用網路或公共託管”
3. 如果是`authenticated`，詢問曝光：
- `private`：“專用網路存取（例如Tailscale），降低設定難度”
- `public`：“面向互聯網部署，安全要求更嚴格”
4. 僅當`authenticated + public`時，要求明確的公共URL

標誌是可選的高級用戶覆蓋，正常設定不需要。

## 配置

預設命令保持交互：

```sh
pnpm paperclipai configure --section server
```

與入門相同的模式/曝光問題和預設設定。

## 醫生

預設命令保持無標誌：

```sh
pnpm paperclipai doctor
```

醫生讀取配置的模式/曝光並套用相關檢查。
可選標誌可能存在用於覆蓋/測試，但對於正常操作來說不是必需的。

## 董事會/使用者資料模型整合（必要）

## 要求

董事會必須是真正的資料庫使用者主體，以便以使用者為中心的功能（任務分配、成員身分、審核身分）一致地運作。

## 目標行為

1. `local_trusted`
- 在設定/啟動期間在 `authUsers` 中播種/確保確定性本地板使用者行。
- 參與者中介軟體使用真實的使用者 ID，而不是僅合成的身份。
- 確保：
  - `instance_user_roles` 包含該用戶的 `instance_admin`。
  - 可以在需要時為此使用者建立/維護公司會員資格。

2. `authenticated`
- 更好的身份驗證註冊創建用戶行。
- 引導/管理流程將此真實使用者提升為 `instance_admin`。
- 第一家公司建立流程應確保創建者會員資格處於活躍狀態。

## 為什麼這很重要

- `assigneeUserId` 驗證檢查公司會員資格。
- 沒有真正的董事會用戶+會員路徑，向董事會用戶分配任務不一致。

## 配置合約（目標）

- `server.mode`: `local_trusted | authenticated`
- `server.exposure`：`private | public`（模式為`authenticated`時需要）
- `auth.baseUrlMode`: `auto | explicit`
- `auth.publicBaseUrl`：當 `authenticated + public` 時需要

已放棄的命名變體沒有相容性別名。

## 無向後相容層

這個改變是一個徹底的改變：

- 刪除程式碼和提示中舊的分割術語的使用。
- 配置模式僅使用上面的規範欄位/值。
- 現有的開發實例可以重新運行載入或更新配置一次。

## 實施階段

## 第 1 階段：共享架構 + 配置表面

- `packages/shared/src/constants.ts`：定義規格模式/曝光常數。
- `packages/shared/src/config-schema.ts`：新增模式/曝光/驗證 URL 欄位。
- `server/src/config.ts` 和 CLI 設定類型：僅使用規格欄位。

## 第 2 階段：CLI 互動使用者體驗- `cli/src/prompts/server.ts`：實現預設模式提示和經過驗證的曝光指導副本。
- `cli/src/commands/onboard.ts`：保持互動優先流程；僅可選覆蓋。
- `cli/src/commands/configure.ts`：伺服器部分的行為相同。
- `cli/src/commands/doctor.ts`：從配置進行模式感知檢查，無標誌預設流程。

## 第 3 階段：運行時/身份驗證策略

- `server/src/index.ts`：強制執行特定於模式的啟動約束。
- `server/src/auth/better-auth.ts`：實現 `auto` 與 `explicit` 基本 URL 行為。
- `authenticated + private` 的主機/來源信任助理。

## 第四階段：董事會主體整合

- 新增確保板用戶啟動/設定步驟：
  - 真實的本地板用戶行
  - 實例管理員角色行
- 確保第一家公司創建路徑授予創建者成員資格。
- 刪除僅合成的假設，因為它們會破壞使用者分配/成員資格語義。

## 階段 5：UI + 文檔

- 圍繞模式和曝光指南更新 UI 標籤/幫助文字。
- 更新文件：
  - `doc/DEPLOYMENT-MODES.md`
  - `doc/DEVELOPING.md`
  - `doc/CLI.md`
  - `doc/SPEC-implementation.md`

## 測試計劃

- 規範模式/暴露/身份驗證欄位的設定模式測試。
- CLI 提示測試預設互動選擇和複製。
- 醫生按模式/暴露進行測試。
- 運行時測試：
  - 經過身份驗證/私人作品，無需明確的 URL
  - 經過身份驗證/公開需要明確的 URL
  - 私有主機原則拒絕不受信任的主機
- 董事會主要測試：
  - local_trusted board用戶作為真實的DB用戶存在
  - 會員設定後，可透過`assigneeUserId`向董事會分配任務
  - 經過身份驗證的流的創建者成員資格行為

## 驗收標準

1. `pnpm paperclipai onboard` 為交互優先，預設為 `local_trusted`。
2. 身份驗證模式是一種運行時模式，具有 `private/public` 暴露指導。
3. `pnpm paperclipai doctor` 透過模式感知檢查進行無標誌工作。
4. 刪除的命名變體不再需要額外的相容性別名稱。
5. 董事會身分由真實的資料庫使用者/角色/會員整合點表示，從而實現一致的任務分配和權限行為。

## 驗證門

合併前：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```