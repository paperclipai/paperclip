# Virtual Office 新手快速啟動

這份是給非工程使用者的最短版。完整疑難排解請看 `docs/virtual-office-startup-sop.zh-TW.md`。

## 每天開工

1. 打開專案資料夾。
2. 雙擊 `scripts/open-virtual-office.cmd`。
3. 等畫面顯示預覽網址。
4. 打開 `http://localhost:5173/AI/office`。

這個啟動入口會保持 `HEARTBEAT_SCHEDULER_ENABLED=false`，不會喚醒 Hermes，不會 Run now，不會啟用排程。

## 如果雙擊失敗

把視窗裡的文字貼給 Codex，並加上：

```text
請依照 Virtual Office 開機 SOP 幫我安全檢查。不要刪資料庫，不要手動刪 lock file，不要 Run now，不要喚醒 Hermes。
```

也可以在專案資料夾打開 PowerShell，改跑：

```powershell
pnpm run office:restart
```

## 開始操作前

先確認畫面或終端有出現：

- Backend OK
- Frontend OK
- Heartbeat scheduler: false

三項都正常後，再測建立、同步 skills、建立 issue 或工作流。

## 還不要做

- 不要刪資料庫資料夾。
- 不要手動刪 `postmaster.pid`。
- 不要按 Run now。
- 不要打開 heartbeat scheduler。
- 不要把 Sandbox/Test 授權沿用到下一個任務。

## 完整驗證

要做開源前或交付前檢查時，再跑：

```powershell
pnpm run office:verify
```

這會檢查 UI 型別、驗收清單、文件連結與預覽健康。
