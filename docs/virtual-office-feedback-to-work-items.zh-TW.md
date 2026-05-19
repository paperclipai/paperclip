# Virtual Office 回報轉工作項目 SOP

這份 SOP 用在回報已經通過 `docs/virtual-office-feedback-triage.zh-TW.md` 分流之後。目標是把朋友、GitHub 讀者或開源試用者的意見，轉成可以追蹤、驗收、收工的工作項目；它不是 Hermes 安裝、Run now、排程或模型喚醒授權。

## 轉換前先確認

- 回報沒有 API key、token、密碼、完整 `.env`、完整 log、私密路徑、正式客戶或公司資料。
- 已用 `docs/virtual-office-feedback-triage.zh-TW.md` 判斷回報類型。
- 若回報涉及安全、密鑰、漏洞或正式資料，先走 `SECURITY.md` 或 private security advisory，不建立公開工作項目。
- 若回報提到 Hermes、Run now 或 schedule trigger，只能建立「前置說明」或「停手線補強」工作，不可直接建立安裝或喚醒任務。

## 工作項目類型

| 回報內容 | 建議建立 | 驗收方式 |
| --- | --- | --- |
| 文件看不懂、步驟太跳 | 文件修正 | 對應文件更新，並在回填卡記錄原句與修改後句子 |
| 按鈕或 UI 文字看不懂 | UI copy 修正 | 畫面文字更新，檢查清單補上 UI 驗收項 |
| 預覽啟動卡住 | 預覽 SOP 或啟動檢查修正 | `pnpm run office:verify` 通過，並補充 startup SOP |
| 回報格式不清楚 | issue template / 試用回報格式修正 | issue form、複製模板或導覽文件更新 |
| skills / workflow 不確定 | Sandbox/Test 驗收任務 | 僅檢查 UI 保存與只讀狀態，不宣稱 runtime skill loading 完成 |
| Hermes 前置疑問 | Hermes readiness 文件修正 | 只補前置檢查與停手線，不填憑證、不喚醒模型 |
| Routine / schedule 安全疑問 | Routine safety 文件修正 | 保留 Sandbox/Test、Run now 與 schedule trigger 停手線 |
| 可能含敏感資訊 | 私下安全處理 | 不公開摘要細節，先移除敏感內容 |

## 建立工作項目的固定格式

```text
## Virtual Office 回報轉工作項目

- 來源：朋友 / GitHub issue / Discord / 試讀回覆 / 其它
- 原始回報摘要：
- 分流類型：文件 / UI / 預覽 / skills / Hermes 前置 / Routine 安全 / 安全通報
- 是否含敏感資訊：否 / 已移除 / 需改走 private security path
- 影響對象：新手 / 維護者 / 英文讀者 / Hermes 前置使用者 / 開源貢獻者

### 要做的修改
- [ ] 文件：
- [ ] UI 文字：
- [ ] 驗收清單：
- [ ] 進度紀錄：
- [ ] 自動檢查：

### 驗收條件
- [ ] `pnpm run office:verify` 通過。
- [ ] 若改文件，文件地圖或相關入口已更新。
- [ ] 若改 UI，畫面可在 Virtual Office 檢查清單或相關區塊看到。
- [ ] 若改驗收項，`docs/virtual-office-acceptance-checklist.zh-TW.md` 與 UI 摘要已同步。
- [ ] 未安裝 Hermes、未填憑證、未建立喚醒 issue、未 Run now、未啟用 schedule trigger。
```

## 判斷是否可以關閉

可以關閉：

- 回報已轉成明確修改，且驗收條件都完成。
- 若暫時不改，已寫明原因與下一步需要的證據。
- 若是安全或敏感資訊，已移到 private security path，公開處只保留非敏感狀態。

先不要關閉：

- 回報只說「看不懂」但沒有指出段落、按鈕或步驟。
- 改了文件但沒有更新文件地圖、檢查清單或進度紀錄。
- 改了 UI 但沒有跑 `pnpm run office:verify`。
- 回報其實是在要求 Hermes 安裝、Run now、排程或模型喚醒，但尚未有明確授權。

## 收工紀錄

每次處理完一批回報後，至少留下：

- 哪些回報已轉成工作項目。
- 哪些回報需要更多讀者證據。
- 哪些回報因安全或敏感資訊改走私下流程。
- 哪些驗收項或文件入口已同步。
- 剩下不能跨越的 Hermes / Run now / schedule trigger 停手線。
