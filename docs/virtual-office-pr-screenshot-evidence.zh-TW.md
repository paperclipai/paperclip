# Virtual Office PR 截圖證據包

這份文件用在開 Virtual Office PR 前。因為 Virtual Office 是可視化工作台，PR 最好附上幾張能讓 reviewer 快速理解價值的畫面。

截圖只作為 PR 證據，不是授權 Hermes、Run now、schedule trigger、heartbeat scheduler 或任何 local model wake-up。

## 產生本機截圖

先確認預覽可用：

```powershell
pnpm run office:check
```

再產生截圖：

```powershell
pnpm run office:pr-screenshots
```

輸出位置：

```text
.paperclip-local/virtual-office-pr-screenshots/
```

這個資料夾已被 `.gitignore` 排除。截圖產生後，先人工檢查是否含有私人資料，再決定是否手動附到 GitHub PR。

## 建議截圖清單

最少準備這些畫面：

1. Office 主工作台
   - 2.5D 辦公室
   - 員工、skills、專案、workflow 或 checklist 摘要
2. 安全狀態或檢查表
   - 顯示目前沒有 active run
   - 顯示 Sandbox/Test 或手動授權邊界
3. 員工與技能管理
   - 讓 reviewer 看出新手可以用視覺方式理解 agent 與 skills
4. 專案 / issue / workflow 畫面
   - 顯示工作流、負責人、上下游或平行工作安排
5. Routine / schedule 安全畫面
   - 顯示 schedule 不會在未授權下自動啟用

如果只附一張，優先附 Office 主工作台。

## 不要附上的內容

截圖中不要出現：

- API key、token、密碼或完整 `.env`
- 私有 repo URL、內網 URL、完整 log
- 正式客戶資料、正式交易資料、未授權資料
- 不能公開的員工名稱、任務內容、討論紀錄
- 任何看起來像 active run、Run now、schedule trigger、heartbeat scheduler 已啟用的畫面，除非 PR 正是在修那個 bug 並已明確說明

## 附到 PR 前檢查

1. 圖片是否真的顯示 Virtual Office，而不是黑畫面、Loading 或錯誤頁。
2. 圖片是否不是只有外框或載入骨架；如果只看到空卡片，請不要附到 PR。
3. 圖片是否能看懂這次 PR 的核心價值。
4. 圖片是否沒有私人資料。
5. PR 文字是否仍保留安全停手線。
6. 若截圖來自本機資料，PR 中要說明它是 local preview evidence，不是正式資料。

## 建議 PR 文字

```markdown
Screenshots:

- Office workbench: shows the 2.5D office, agents, skills, projects, and workflow summary.
- Safety/checklist view: shows the no-active-run and explicit-authorization boundaries.

The screenshots were captured from a local preview. They do not include secrets, production data, Run now, schedule trigger, heartbeat scheduler, or local-model wake-up evidence.
```
