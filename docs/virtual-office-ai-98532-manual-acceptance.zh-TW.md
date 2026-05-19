# AI-98532 人工驗收交接清單

更新日期：2026-05-15

這份文件只記錄 `AI-98532` 需求整理完成後，使用者人工檢查與下一步啟動 `AI-98533` 前需要確認的事項。這不是 Hermes、Claude、本地模型或任何 agent 的喚醒授權。

## 目前狀態

- `AI-98532` 狀態：`done`
- `AI-98532` active run：無
- `AI-98532` checkout run：無
- `AI-98537` recovery issue：`done`，無 active run
- `沙雕2` 狀態：`paused / manual`
- 後端與前端：`office:restart` 後健康

## 已完成的安全補強

- 一次性喚醒可標記 `oneTimeAuthorization=true`。
- 一次性喚醒遇到 `529`、timeout、adapter failed 或 transient error 時，只記錄失敗並停止。
- 一次性喚醒不自動 retry。
- 一次性喚醒不自動建立 recovery issue。
- 一次性喚醒不開 liveness continuation。
- 帶有 `oneTimeAuthorization` 的 run comment 不會 reopen 已完成 issue。
- 帶有 `oneTimeAuthorization` 的 run comment 不會再喚醒 assignee。
- Agent 預設指令已補上：不得檢查、列印、echo、枚舉或推測 secrets、tokens、API keys、auth headers、cookies、credentials、敏感環境變數。

## 已通過的技術檢查

- `packages/adapter-utils/src/server-utils.test.ts` 的 execution contract 測試通過。
- `server/src/__tests__/issue-comment-reopen-routes.test.ts` 的 one-time authorized run comment 測試通過。
- `@paperclipai/server` typecheck 通過。
- `@paperclipai/adapter-utils` typecheck 通過。
- `office:restart` 通過，後端與前端皆 OK。

## 人工驗收項目

### 1. 需求文件

- [ ] 開啟 `AI-98532`。
- [ ] 確認 `requirements` / `需求文件 v1.0` 存在。
- [ ] 確認文件有整理目標、限制、成功標準與待補問題。
- [ ] 確認內容符合「晨間財經新聞團隊」的實際需求。
- [ ] 確認沒有 API key、token、密碼、完整 `.env`、本機私密路徑或不該公開的資料。

### 2. 討論與回覆紀錄

- [ ] 確認沙雕2最後的確認 comment 沒有要求繼續自動執行。
- [ ] 確認 comment 沒有建立新 issue、沒有要求 Run now、沒有啟用 schedule trigger。
- [ ] 確認 `AI-98532` 畫面沒有 active run 或 recovery chain 讓人誤會任務失控。

### 3. 下游工作 AI-98533

- [ ] 確認 `AI-98533` 是下游方案設計工作。
- [ ] 確認 `AI-98533` 目前仍是等待人工決定是否啟動。
- [ ] 啟動前先決定要由哪位員工負責。
- [ ] 啟動前先決定是否需要模型喚醒；若需要，仍要新的逐字一次性授權。
- [ ] 不要把 `AI-98532` 的舊授權沿用到 `AI-98533`。

## 下一步建議

如果人工驗收通過，下一步可以進入 `AI-98533` 的方案設計前檢查。建議先只讀檢查 `AI-98533` 的狀態、負責員工、workflow 關係與是否有 active run，再決定是否需要新的授權句。

## 停手線

遇到以下任一情況，先停止，不要喚醒 agent：

- 畫面出現 active run、retry、recovery 或 automation chain。
- 文件或 comment 出現 API key、token、密碼、完整 `.env` 或敏感路徑。
- `AI-98533` 的負責人、任務範圍或上下游關係不清楚。
- 使用者尚未明確同意下一次喚醒。
