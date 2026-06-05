# Virtual Office PR 審查 SOP

這份 SOP 給維護者審查 Virtual Office 相關 PR 時使用。目標是確認貢獻內容小而可驗證、文件與 UI 檢查清單同步，並確保 PR 沒有安裝 Hermes、填憑證、Run now、啟用排程、喚醒模型或提交敏感資料。

## 先看 PR 範圍

- PR 是否只處理一個明確問題或一組小型相關修改。
- 是否對應 `docs/virtual-office-feedback-to-work-items.zh-TW.md` 的工作項目格式，或至少清楚說明來源回報。
- 若是第一次貢獻，是否符合 `docs/virtual-office-first-contribution.zh-TW.md` 的小範圍修改。
- 若 PR 涉及 Hermes、Run now、schedule trigger、密鑰、`.env`、正式資料或資料庫修復，先暫停，不要當成一般 PR 合併。

## 必看檢查

- PR 描述有填 `.github/PULL_REQUEST_TEMPLATE.md` 的 Virtual Office verification block。
- 有列出 `pnpm run office:verify` 結果；若沒跑，請作者補。
- 若改 UI，有手動看過 `http://localhost:5173/AI/office` 或提供畫面說明。
- 若改文件，有更新相關文件地圖或 README / 開源導覽入口。
- 若改功能狀態，有同步 `docs/virtual-office-acceptance-checklist.zh-TW.md` 與 UI 摘要。
- 若改開源流程，有同步 release checklist、maintainer daily SOP 或相關 SOP。

## 安全停手線

請確認 PR 沒有：

- 安裝 Hermes 或其它本地模型。
- 填 API key、token、密碼或完整 `.env`。
- 建立喚醒 issue、Run now、啟用 schedule trigger 或打開 heartbeat scheduler。
- 把 UI skills 同步宣稱為 runtime skill loading 完成。
- 把文件模板宣稱為真人試讀完成。
- 提交 `.paperclip-dev-config.json`、`.virtual-office-preview-status.json`、log、私密路徑、正式客戶或公司資料。

## 回覆範本

可以合併前：

```text
Virtual Office PR review:
- Scope: small and focused / needs narrowing
- Verification: `pnpm run office:verify` pass / needs author update
- Docs/UI/checklist sync: pass / needs update
- Safety stop lines: no Hermes install, no Run now, no schedules, no secrets
- Decision: approve / request changes
```

需要修改時：

```text
Thanks, this is close. Before merge, please update:
- [ ] Verification result for `pnpm run office:verify`
- [ ] Acceptance checklist or UI summary
- [ ] Related docs map / README / open-source guide
- [ ] Explicit confirmation that this PR did not install Hermes, press Run now, enable schedules, wake a model, or include secrets
```

## 合併前最後確認

- `pnpm run office:verify` 通過。
- Backend / Frontend OK，或 blocked 狀態已照 startup SOP 記錄且未改資料。
- 新增文件有被文件連結檢查掃到。
- UI 檢查清單看得到新增或修改項目。
- PR 沒有把 Hermes/local model wake-up gate 從 `待開發` 提前改成完成。
