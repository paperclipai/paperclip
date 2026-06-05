# Virtual Office Hermes 本地模型 SOP

這份文件用來處理 Virtual Office 接上 Hermes Agent 前的檢查。目標是先確認環境，再建立沙盒員工，最後才做真喚醒，避免還沒設定好就產生一堆失敗任務或 recovery issues。

## 開源引用方式：source-first bridge

Hermes Windows/WSL bridge 不應依賴某台電腦上的預先編譯二進位。公開引用時請保留 source-first 流程：

1. 使用者先在 WSL 內安裝 Hermes CLI，並確認 `hermes --version` 可用。
2. 如 WSL distro 不是 `Ubuntu`，設定 `HERMES_WSL_DISTRO`。
3. 如 Hermes CLI 不在 WSL PATH，設定 `HERMES_WSL_PATH`，例如 `/home/<wsl-user>/.local/bin/hermes`。
4. Windows 端需要 `.exe` bridge 時，執行：

```powershell
pnpm run hermes:wsl-bridge:build
```

這會由 `scripts/hermes-wsl-bridge.cs` 產生 `scripts/hermes-wsl.exe`。`scripts/hermes-wsl.exe` 是本機建置產物，已加入 `.gitignore`，不需要提交到 GitHub。

`HERMES_WSL_DISTRO` 與 `HERMES_WSL_PATH` 只描述本機工具位置，不是 API key、token 或密碼。不要把任何 Hermes provider key、OpenAI-compatible endpoint credential、完整 `.env` 或含憑證的 log 貼進 issue。

## 目前狀態

Paperclip 後端已註冊 `hermes_local` adapter，且支援 skills 與本地 agent token。也就是說，Virtual Office 可以先建立 Hermes 員工草稿。

目前已完成到：

- WSL2 內 `hermes` CLI 可由 Windows 後端透過 `scripts/hermes-wsl.cmd` 呼叫。
- Windows Ollama bridge 可由 WSL2 讀到 `/v1/models`，Hermes 已設為 `custom` provider 與 `qwen2.5:14b`。
- `hermes_local` Test environment 已能辨識本地 Ollama 模式並回傳 `pass`。
- 已建立 `Hermes Sandbox Engineer`，同步 starter skills，且 heartbeat 關閉。
- 已建立第一張 Sandbox/Test 前置 issue `AI-97978`，並已使用明確一次性授權做 Sandbox/Test 喚醒。
- 第一次喚醒 run `ac907688-9bb3-4a35-8656-349e39a787e7` 失敗於 `adapter_failed`；根因是相對 command `scripts\hermes-wsl.cmd` 在實際執行工作區找不到，不是模型本身回覆失敗。
- 第一次 retry run `281764c1-b8ff-423c-826a-e579985f40ea` 及 continuation `2f91bc6b-4078-45c7-99c9-cf8cb9e7f553` 顯示 `.cmd` bridge 不能穩定轉送 Paperclip 的多行 prompt。
- 已改用 `scripts\hermes-wsl.exe` bridge 並設定 Hermes 64K context override；第二次明確授權 retry run `ed6de5fa-5807-4a44-a96e-2da0f3b051e3` 成功，Hermes session `20260511_131730_5c90ed`，且已由 `Hermes Sandbox Engineer` 在 `AI-97978` 留下可覆盤留言。
- 完成後已暫停 `Hermes Sandbox Engineer`，`AI-97978` 已收尾為 `done`，未 Run now、未啟用 schedule trigger、未打開 heartbeat scheduler、未接正式專案、未處理正式資料、未連續喚醒。
- 第二張 Sandbox/Test issue `AI-98227` 也已在使用者明確一次性授權下安全喚醒；run `515b2fe4-b3b3-4586-84b1-af8cd03cca79` 成功，留言 `932886db-66cb-45eb-a283-5587741a8369` 已寫回 issue，完成後 `Hermes Sandbox Engineer` 已暫停，`AI-98227` 已收尾為 `done`。
- `AI-98227` 證明第二次受控喚醒與停手流程可運作，但 Hermes 回覆尚未明確列出 `paperclipai/paperclip/...` 等 Paperclip runtime skill key；runtime skills key 回報仍需補強 adapter/bridge 提示後再驗收。
- 已建立下一張完全測試用 issue `AI-98228`，用來在未來明確授權後驗證 exact runtime skill key 回報；目前狀態為 `backlog`，未 Run now、未喚醒、未產生 active run。
- 後續若要再喚醒，仍只接受明確點名 `AI-97978` 或新的 Sandbox/Test issue 的一次性授權；`請繼續`、`下一步`、`可以`、`照你建議` 都不算授權。

目前還沒完成的是：

- 若要做第二張 Sandbox/Test 任務，必須重新取得明確一次性授權；「繼續」本身不算喚醒授權。
- 第二張 `AI-98227` 已完成一次性喚醒，後續不可再沿用該授權；下一步不是第三次喚醒，而是補強 runtime skill key 回報證據。
- `AI-98228` 已準備好作為下一次 exact runtime skill key 驗證 issue；只有使用者另貼明確點名 `AI-98228` 的一次性授權句時，才可進行單次 Sandbox/Test 喚醒。
- run detail endpoint 已重查可正常回傳成功 run；並已修正後續流程，讓成功補上 issue 留言後會重新計算 liveness，避免已留言的 run 仍被標成 `needs_followup`。
- 正式專案、正式資料、Run now、schedule trigger 與 heartbeat scheduler 仍維持關閉，直到另行完成正式上線前的安全設計。

## 第二個 Sandbox/Test 任務準備

第一次 `AI-97978` 成功只證明 Hermes Sandbox Engineer 能在受控條件下回覆並留下紀錄，不代表可以連續喚醒。若要準備第二個 Sandbox/Test 任務，先用 Office 的 `複製第二沙盒準備`，只整理候選 issue 與安全邊界。

第二張任務必須符合：

- issue 名稱或描述含 `Sandbox`、`Test`、`沙盒` 或 `測試`。
- 專案是 `Virtual Office Sandbox` 或明確 Sandbox/Test 專案。
- 只驗證一個能力，例如讀取 issue 上下文、列出 skills、整理測試紀錄或提出下一個安全檢查。
- 不修改正式專案、正式任務、正式員工或正式資料。
- 不包含 API key、token、密碼、完整 `.env` 或私密 URL。
- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。
- 不把 `AI-97978` 的成功結果延伸成第二次喚醒授權。

準備卡的判斷：

- `READY`：可以建立或確認 Sandbox/Test issue 草稿，但仍不喚醒 Hermes。
- `WAIT`：候選 issue、測試目的或安全邊界不清楚，先補資料。
- `PAUSE`：出現正式資料、敏感資訊、running run、recovery、blocker 或授權不清楚，立刻停下。

真正第二次喚醒前，使用者必須重新貼出明確一次性授權句，並點名新的 Sandbox/Test issue 與 Hermes Sandbox/Test 員工。

仍然不要貼 API key、token、密碼或完整 `.env`；本地 Ollama 路線目前不需要雲端 API key 才能做第一次沙盒喚醒。

### 第二個 Sandbox/Test issue 草稿

Office 也提供 `複製第二 issue 草稿` 與 `預填第二 issue`。這兩個入口只負責建立待辦 issue 草稿，方便使用者之後人工檢查，不會自動 Run now，也不是喚醒授權。

第二張 issue 草稿必須保留這些文字：

- 這是第二個 Sandbox/Test 任務草稿，不代表喚醒授權。
- 不沿用 `AI-97978` 的一次性授權。
- 建立後先停下覆盤。
- 若未來真的要喚醒，必須重新取得逐字一次性授權。
- Hermes 若被授權，只能回覆 skills、Sandbox/Test 邊界與下一個最小安全步驟。

建立第二張 issue 草稿後，先用 `複製第二 issue 覆盤` 檢查：

- issue 仍是 `todo` 或 `backlog`，不能是 `running`。
- 沒有新增 Run now、schedule trigger 或 heartbeat scheduler。
- 沒有 queued/running Hermes runs。
- 沒有 recovery issue 或 blocker。
- 沒有正式專案、正式資料、API key、token、密碼、完整 `.env` 或私人 URL。
- 結果若是 `CLEAN`，只記錄覆盤，仍不喚醒 Hermes。

若未來要真的做第二次喚醒，先用 `複製第二授權模板`，但模板本身不算授權。使用者必須把 `AI-____`、issue 標題與 Sandbox/Test 員工填完整後，另行貼出完整授權句。

第二次授權句必須同時包含：

- 單一 Sandbox/Test issue 編號。
- 單一 Hermes Sandbox/Test 員工。
- 只做一次喚醒。
- 完成後立刻停下覆盤。
- 不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。
- 不接正式專案、不處理正式資料、不連續喚醒。
- 不沿用 `AI-97978` 的授權。

使用者貼回第二次授權句後，先用 `複製第二授權判讀`，只做 ACCEPT / WAIT / PAUSE：

- `ACCEPT`：授權句與現場狀態全部符合，下一步也只能進第二沙盒喚醒前最後確認，不能立刻喚醒。
- `WAIT`：缺 issue、員工、一次性、完成後停下覆盤或禁止事項，請使用者重貼完整句子。
- `PAUSE`：包含 Run now、排程、heartbeat、正式資料、憑證、連續喚醒、多 issue、沿用 `AI-97978` 授權、running run 或 recovery。

授權判讀為 `ACCEPT` 後，仍要先用 `複製第二最後確認`。它會再次核對：issue 不是 `AI-97978`、狀態不是 `running` / `done` / `cancelled`、Hermes 員工仍是 `paused/manual`、Backend/Frontend OK、heartbeat scheduler 為 false，且沒有 queued/running runs、recovery、排程、正式資料或敏感資訊。最後確認通過只代表可準備單次執行交接，仍不是連續喚醒或正式專案授權。

2026-05-07 本機只讀盤點結果：

| 項目 | 結果 | 判斷 |
| --- | --- | --- |
| `python --version` | Python 3.14.3 | 可用，符合 Hermes 需要的 Python 3.10+。 |
| `python3 --version` | Python 3.14.3 | 可用，後端 adapter 檢查 `python3` 時應能通過。 |
| `pip --version` | pip 26.0.1，對應 Python 3.14 | 可用。 |
| `where python` | `WindowsApps\python.exe` 與 `Python\bin\python.exe` | 有兩個入口，安裝後若 PATH 行為怪異，要優先確認實際使用哪個 Python。 |
| `where pip` | `C:\Users\<you>\AppData\Local\Python\bin\pip.exe` | 可用。 |
| `where hermes` | 找不到 | 尚未安裝 Hermes CLI，Office 顯示 `本地 CLI / 待安裝` 是正確狀態。 |

2026-05-07 安裝嘗試紀錄：

- 已嘗試 `python -m pip install hermes-agent`。
- 結果：PyPI 找不到 `hermes-agent` 可安裝版本，沒有安裝任何 Hermes CLI。
- 官方 Hermes Agent 安裝文件目前寫明：Native Windows 不支援，Windows 使用者應安裝 WSL2，並在 WSL2 內執行官方安裝器。
- 官方來源：`https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/installation.md`
- 本機已有 WSL2 `Ubuntu`，因此下一步建議改走 WSL2 安裝路線；安裝完成後，還要補一層 Paperclip 從 Windows 呼叫 WSL Hermes 的橋接，才能讓 `hermes_local` adapter 自動測到 CLI。

目前建議下一步只做 WSL2 Hermes CLI 安裝與橋接規劃，不做 agent 真喚醒；橋接完成後回 Office 按 `重新檢查`。

2026-05-08 WSL2 bridge 驗證結果：

| 項目 | 結果 | 判斷 |
| --- | --- | --- |
| Windows bridge | `scripts\hermes-wsl.cmd --version` 可回應 | Windows Paperclip 可以透過 bridge 呼叫 WSL2 內的 Hermes。 |
| Hermes 版本 | Hermes Agent v0.12.0 (2026.4.30) | CLI 本體可用。 |
| Hermes model | `not set` | 尚未設定模型，不能喚醒 agent。 |
| Hermes `.env` | not found | 尚未設定 provider/API key，不能喚醒 agent。 |
| Office Test environment | `warn` | bridge 可用，但模型與憑證待設定；這是安全的暫停狀態。 |

目前 Office 的 `Hermes / local model gate` 會顯示三段式路線：

1. Bridge 是否可用。
2. Hermes model / provider / API key 是否已設定。
3. 是否可以進入 Sandbox/Test 任務做第一次喚醒。

只要還是 `warn` 或顯示待設定，就不要按喚醒，也不要把正式 issue 指派給 Hermes。

借鏡 Hermes Desktop 的 local / remote backend 分流，Office 會先顯示 `Hermes 接入模式選擇`：

- `本機 Hermes`：走目前 WSL2 / Windows bridge 路線，先命令預覽與逐條同意，不自動安裝。
- `遠端 Hermes API`：只做路線規劃與非敏感狀態檢查；Office 不保存 API key、token 或密碼。
- `尚未決定`：維持第 0 階只讀準備，只看教學、診斷與需求。

需要交接時可按 `複製接入判斷`。這份卡不是安裝授權、不是遠端連線授權，也不是憑證授權；它只幫新手決定應該走哪條路。

2026-05-10 安裝狀態再盤點：

| 項目 | 結果 | 判斷 |
| --- | --- | --- |
| Windows bridge | `scripts\hermes-wsl.cmd --version` 可回應 | Windows Paperclip 仍可透過 bridge 呼叫 WSL2 內的 Hermes。 |
| Hermes 版本 | Hermes Agent v0.12.0 (2026.4.30) | CLI 已存在；下一步不是重裝，而是設定與只讀檢查。 |
| Hermes project | `/home/<wsl-user>/.hermes/hermes-agent` | WSL2 端專案位置存在；公開文件只使用佔位路徑。 |
| Python | 3.11.15 | 符合 Hermes 執行需求。 |
| Gateway service | running | Gateway 已在 WSL2 端運作，但這不代表可以喚醒 agent。 |
| Hermes `.env` | not found | 尚未設定 provider / API key。 |
| Hermes model | not set | 尚未選定模型。 |
| API keys / OAuth providers | not configured / not logged in | 不要把密鑰貼進 Office、issue、文件或對話；需由使用者在 Hermes 自己的設定位置處理。 |
| Scheduled jobs | 0 | 目前沒有排程工作。 |
| Active sessions | 0 | 目前沒有活躍 Hermes session。 |

結論：Hermes CLI 已安裝且 bridge 可用，現在卡在第 3 階「模型與憑證設定檢查」之前；不要重複安裝，不要 Run now，不要建立喚醒 issue，不要啟用 schedule trigger，也不要喚醒 Hermes。若要繼續，先由使用者明確選擇 provider/model，並在 Hermes 自己的設定位置處理憑證，再只回報非敏感狀態。

2026-05-11 本地 Ollama 串接更新：

| 項目 | 結果 | 判讀 |
| --- | --- | --- |
| Hermes CLI | `Hermes Agent v0.12.0 (2026.4.30)` | 已安裝，不需要重複安裝。 |
| Windows Ollama | `ollama version 0.22.0`，模型包含 `qwen2.5:14b`、`qwen2.5:7b`、`deepseek-r1:8b` | 本機模型已存在。 |
| WSL 直連 Ollama | `127.0.0.1:11434` 連線失敗 | Windows 與 WSL 的 localhost 邊界正常存在，需要橋接。 |
| Hermes Ollama bridge | `pnpm run hermes:ollama-bridge:restart` 建立 `http://<WSL gateway>:11435/v1` | WSL 端可讀到 `/v1/models`，Hermes 可用 OpenAI-compatible endpoint 連本地 Ollama。 |
| Hermes model | `provider=custom`、`base_url=http://<WSL gateway>:11435/v1`、`default=qwen2.5:14b` | 第 3 階模型設定已完成到「本地模型可見」。 |
| Hermes `.env` | 已建立空的 `~/.hermes/.env`，權限 `600` | 不含 API key；只是讓 Hermes 設定檢查不再缺基本 secrets 檔。 |

橋接工具只轉送本機 Ollama API，不填 API key、不建立 issue、不 Run now、不啟用 schedule trigger，也不喚醒 Hermes。重開機後若 Hermes 連不到模型，先啟動 Ollama，再在 repo 內執行 `pnpm run hermes:ollama-bridge:restart`。

2026-05-20 Virtual Office / Eve / Hermes local 成功鏈路：

| 項目 | 結果 | 判讀 |
| --- | --- | --- |
| Virtual Office preview | Backend OK、Frontend OK，heartbeat scheduler 為 false | Office 控制台可作為本地 AI 操作入口。 |
| Ollama | `127.0.0.1:11434/api/tags` 可讀，包含 `qwen2.5:14b` | 本地模型服務已啟動。 |
| Hermes Ollama bridge | WSL 可讀 `http://<WSL gateway>:11435/v1/models` | Hermes 的 OpenAI-compatible provider 可連到 Windows Ollama。 |
| Hermes WSL bridge | `scripts/hermes-wsl.exe chat -q ...` 可進入 Hermes CLI | Windows Paperclip 可把 prompt 轉送給 WSL Hermes。 |
| Eve preflight | Eve 為 `paused/manual`，`AI-98533` 無 active/live run，ordinary task 隱藏 detailed skill instructions | 喚醒前安全條件成立。 |
| 一次性喚醒 | 使用者明確授權後，只對 `AI-98533` 做一次 Eve / Hermes local 喚醒 | run `d0f49e13-8636-4c8c-8e08-a438c629347f` 成功。 |
| 回寫 | Eve 在 `AI-98533` 留下方案設計 comment | `Virtual Office -> Eve -> Hermes local -> Ollama/qwen2.5:14b -> issue comment` 已跑通。 |
| 收尾 | Eve 回到 `paused/manual`，`AI-98533` 收回 `backlog`，active/live run 為 0 | 沒有自動 retry、recovery issue 或 continuation。 |

重開機後若要重新確認本地 AI stack，可用：

```powershell
pnpm run office:local-ai-start
```

這個指令只啟動與檢查 Office preview、Ollama、Hermes Ollama bridge、Eve 安全狀態與測試 issue run 狀態；它不會喚醒 Eve，不會 Run now，不會開 schedule trigger，也不會啟用 heartbeat scheduler。即使顯示 READY，真正喚醒仍必須重新取得逐字一次性授權。

2026-05-11 第一次 `AI-97978` 一次性喚醒已用完。結果是 `adapter_failed`，不是模型回答失敗；根因是相對 `scripts\hermes-wsl.cmd` 在實際執行工作區不可解析。已修正為絕對路徑並暫停 Hermes Sandbox Engineer。若要 retry，先處理 blocked/recovery 狀態，再重新取得一次性授權。

2026-05-11 `AI-97978` retry 已用完。這次路徑問題已解決，但 `.cmd` bridge 會把 Paperclip/Hermes 的多行 prompt 拆成錯誤 CLI 參數，造成 `hermes: error: unrecognized arguments`。已新增並編譯 `scripts\hermes-wsl.exe` bridge，改用可保留多行參數的 Windows 可執行橋接；同時設定 `model.context_length = 65536` 與 `auxiliary.compression.context_length = 65536`。CLI smoke test 已能用多行 prompt 回覆 `OK`，但 Paperclip agent 尚未再次 retry；下一次仍要重新取得一次性授權。

2026-05-11 `AI-97978` bridge 修正後 retry 成功。使用者再次明確授權後，只對 `AI-97978` 做一次 Sandbox/Test 喚醒，run `ed6de5fa-5807-4a44-a96e-2da0f3b051e3` 成功，exit code 0，Hermes session `20260511_131730_5c90ed`。Hermes 在 issue 留言列出可用 skills，並確認目前只處理名稱含 `Sandbox`、`Test`、`沙盒` 或 `測試` 的任務與專案。完成後已暫停 `Hermes Sandbox Engineer`，`AI-97978` 已收尾為 `done`；這次授權已用完，不可把結果延伸成第二次喚醒、Run now、排程或正式專案處理。

2026-05-11 run 覆盤穩定性補強：成功 run detail 已可正常讀取；server 後續也會在 issue 留言狀態變成 `satisfied` 後重新計算 liveness。這能避免「已經留下留言」的成功 run 還被標成 `needs_followup`。既有 `AI-97978` run `ed6de5fa-5807-4a44-a96e-2da0f3b051e3` 已校正為 `advanced`。

2026-05-11 第二個 Sandbox/Test issue `AI-98227` 已完成一次性受控喚醒。使用者明確授權後，只由 `Hermes Sandbox Engineer` 回覆該 issue；run `515b2fe4-b3b3-4586-84b1-af8cd03cca79` 成功，exit code 0，Hermes session `20260511_172324_7880d1`，留言 `932886db-66cb-45eb-a283-5587741a8369` 已寫回 issue。完成後已暫停 `Hermes Sandbox Engineer`，`AI-98227` 已收尾為 `done`，active run 為空，heartbeat scheduler 仍為 false。這次授權已用完，不可延伸成第三次喚醒、Run now、排程或正式專案處理。

2026-05-11 `AI-98227` runtime skills 覆盤：這次成功證明第二張 Sandbox/Test issue 的安全喚醒、留言與停手流程可以運作；但 Hermes 回覆列出的是 `terminal`、`search_files`、`patch`、`write_file` 等通用工具能力，尚未明確回報 `paperclipai/paperclip/...` 或公司 skill key。下一步要補強 Hermes adapter/bridge 的 prompt，要求模型在 Sandbox/Test 回覆中逐字列出 exact runtime skill keys，才能把 runtime skill key 回報證據改為已驗證。

## 第 1 步：安裝前確認

先不要啟動 heartbeat，也不要直接把正式任務指派給 Hermes。

確認這些條件：

1. Paperclip 預覽健康檢查是 OK。
2. Office 頁面沒有 `Restart Required`。
3. 沒有 running/error 員工或 queued/running 舊工作。
4. 你知道這次只會用 `Sandbox` 或 `Test` 測試資料。
5. 你已經準備好一組可給 Hermes 使用的模型服務或 API key。

Office 主畫面的 `Hermes / local model gate` 也會列出同一組「安裝前確認」：

| 項目 | 通過標準 |
| --- | --- |
| 預覽健康 | `pnpm run office:check` 顯示 Backend OK / Frontend OK，畫面沒有 Restart Required。 |
| Windows 路線 | 官方 Hermes Agent 目前不支援 Native Windows；Windows 使用者先確認 WSL2/Ubuntu 可用。 |
| Hermes CLI | WSL2 內安裝後能執行 `hermes --help` 或 `hermes --version`，再補 Paperclip 可呼叫的橋接。 |
| 模型憑證 | 只先設定一個 provider、model 與 API key，且 API key 不寫進公開文件或任務內容。 |
| 沙盒邊界 | 第一次只使用 Sandbox/Test 員工、專案與 issue，不指派正式任務，不開自動 heartbeat。 |

如果其中任何一項不確定，先停在這一步，把錯誤訊息或畫面狀態補進驗收紀錄。

如果你只想做到安裝前一刻，請在 Office 按 `複製安裝前檢查包`。它會把事情分成：

- `我可以自己先做`：只做預覽健康、打開 Office、準備 WSL2/Ubuntu 視窗。
- `需要 Codex 陪同`：交接設定指引、provider/model 選擇與不含憑證的錯誤訊息。
- `現在先不要碰`：不要執行安裝、不要填 API key、不要建立喚醒 issue、不要 Run now、不要喚醒 Hermes。

這份檢查包的目的，是停在安裝 Hermes 的前一刻；真正開始安裝或設定前，必須由使用者明確要求。

貼出安裝授權前，可以先按 `複製總檢`。這份總檢會把預覽、Bridge/CLI、模型憑證、Sandbox/Test 邊界與跨線授權整理成 `READY FOR USER AUTHORIZATION`、`WAIT` 或 `PAUSE`：

- `READY FOR USER AUTHORIZATION`：只代表可以請使用者閱讀並決定是否貼出 `Hermes 安裝授權文字`。
- `WAIT`：仍有前置條件缺項，例如預覽、bridge、provider/model/API key 狀態或 Sandbox/Test 邊界尚未清楚。
- `PAUSE`：出現憑證、正式資料、來源不明命令、Run now、schedule trigger、建立 issue 或喚醒模型等風險。

這份總檢不是安裝授權、不是憑證授權、不是 Run now 授權，也不是模型喚醒授權。它只幫新手判斷現在能不能進到「請你授權」那一步。

如果總檢是 `WAIT`，請按 `複製 WAIT 補齊`。這份補齊包會列出目前缺項、下一個安全動作，以及仍然禁止跨過的線：

- 可做：重新跑 `office:verify`、只讀確認 WSL2/Ubuntu、Hermes bridge、Test environment、provider/model 非敏感狀態。
- 可做：複製命令預覽或第 1 階命令表單，先列命令，不執行。
- 不可做：安裝、下載、寫檔、改 PATH、改設定，除非使用者另行逐條同意。
- 不可做：要求、讀取或貼出 API key、token、密碼、完整 `.env` 或私密 URL。
- 不可做：建立 issue、Run now、啟用 schedule trigger、打開 heartbeat scheduler、喚醒 Hermes 或接正式專案。

補齊後先重新跑 `office:verify`，再按一次 `複製總檢`。若仍是 `WAIT`，只補下一個缺項；若是 `READY FOR USER AUTHORIZATION`，也只代表可以請使用者決定是否貼出安裝授權。

若你已決定跨過安裝線，請在 Office 按 `複製安裝授權`，再把授權文字貼給 Codex。授權文字會明列：

- 可以先跑 `office:verify` 與檢查 WSL2/Ubuntu。
- 命令必須先顯示，等使用者同意後再執行。
- 不可自動填 API key、token、密碼。
- 不可建立喚醒 issue、Run now、啟用 schedule trigger 或喚醒 Hermes。
- 遇到憑證、正式資料、排程或不確定命令時必須停下問使用者。

在真正判定授權前，請先按 `複製授權句檢查`。`好的`、`繼續`、`下一步`、`可以`、`請繼續`、`照你建議` 都不算 Hermes 安裝授權；只有使用者明確寫出要開始 Hermes 安裝或設定，且仍限制不填憑證、不建立喚醒 issue、不 Run now、不啟用 trigger、不喚醒 Hermes，才可判定為 `ACCEPT`。

若授權句檢查是 `WAIT` 或 `PAUSE`，請按 `複製授權 WAIT/PAUSE`。`WAIT` 只允許請使用者補明確授權文字或回去閱讀安裝授權文字；`PAUSE` 只允許停下並回到最終閘門 PAUSE 修補。兩者都不是安裝授權、重試授權或命令執行授權。

若授權句檢查是 `ACCEPT`，請再按 `複製 ACCEPT 交接`。這份交接卡只允許進入逐條命令陪同：每次只執行使用者明確同意的一條命令，完成後記錄結果與敏感資訊檢查。它不擴張成填憑證、建立喚醒 issue、Run now、schedule trigger 或模型喚醒授權。

ACCEPT 交接完成後，請先按 `複製第一命令預覽`。它只允許 Codex 列出 `HERMES-INSTALL-001` 這一條候選命令、目的、風險與停手線；這不是執行授權，也不是連續安裝授權。

若你確認第一條候選命令可以執行，請按 `複製第一命令同意`。這張卡只同意或拒絕 `HERMES-INSTALL-001` 這一條命令，且實際命令必須和預覽完全一致；執行後要立刻停下回報結果，不可延伸成 `HERMES-INSTALL-002`、`HERMES-NEXT-001`、憑證填寫、Run now、排程或喚醒授權。

`HERMES-INSTALL-001` 執行後，請按 `複製第一命令結果`。它會要求確認實際命令是否和預覽一致、是否下載或安裝套件、是否修改 PATH/設定/檔案、是否出現憑證或越線行為，並把結果標成 `PASS` / `WAIT` / `PAUSE`。未完成這張回報前，不可列下一條或執行下一條。

完成第一命令結果回報後，請按 `複製第一命令判讀`。`PASS` 只代表 `HERMES-INSTALL-001` 乾淨，最多只能進入下一張指定安全卡，或請使用者決定是否回到下一條命令預覽；`WAIT` 只允許補資訊或只讀檢查；`PAUSE` 代表立刻停下排查。任何判讀都不是 `HERMES-INSTALL-002`、`HERMES-NEXT-001`、憑證、Run now、排程或喚醒授權。

完成第一命令判讀後，請按 `複製第一循環總結`。它會記錄 `HERMES-INSTALL-001` 的預覽、同意、結果、判讀、安全檢查與下一張安全卡；這份總結只做交接與覆盤，不會授權 `HERMES-INSTALL-002`、`HERMES-NEXT-001`、憑證、Run now、排程或喚醒。

若 `HERMES-INSTALL-001` 循環總結的最後判讀是 `PASS`，且你只想知道下一步可能命令，請按 `複製第二命令預覽`。它只允許 Codex 列出 `HERMES-INSTALL-002` 這一條候選命令、目的、風險與停手線；這不是執行授權，也不是連續安裝授權。

若你確認第二條候選命令可以執行，請按 `複製第二命令同意`。這張卡只同意或拒絕 `HERMES-INSTALL-002` 這一條命令，且實際命令必須和預覽完全一致；執行後要立刻停下回報結果，不可延伸成 `HERMES-INSTALL-003`、`HERMES-NEXT-001`、憑證填寫、Run now、排程或喚醒授權。

`HERMES-INSTALL-002` 執行後，請按 `複製第二命令結果`。它會要求確認實際命令是否和預覽一致、是否下載或安裝套件、是否修改 PATH/設定/檔案、是否出現憑證或越線行為，並把結果標成 `PASS` / `WAIT` / `PAUSE`。未完成這張回報前，不可列下一條或執行下一條。

完成第二命令結果回報後，請按 `複製第二命令判讀`。`PASS` 只代表 `HERMES-INSTALL-002` 乾淨，最多只能進入下一張指定安全卡，或請使用者決定是否回到下一條命令預覽；`WAIT` 只允許補資訊或只讀檢查；`PAUSE` 代表立刻停下排查。任何判讀都不是 `HERMES-INSTALL-003`、`HERMES-NEXT-001`、憑證、Run now、排程或喚醒授權。

完成第二命令判讀後，請按 `複製第二循環總結`。它會記錄 `HERMES-INSTALL-002` 的預覽、同意、結果、判讀、安全檢查與下一張安全卡；這份總結只做交接與覆盤，不會授權 `HERMES-INSTALL-003`、`HERMES-NEXT-001`、憑證、Run now、排程或喚醒。

若 `HERMES-INSTALL-002` 循環總結的最後判讀是 `PASS`，且你只想知道下一步可能命令，請按 `複製第三命令預覽`。它只允許 Codex 列出 `HERMES-INSTALL-003` 這一條候選命令、目的、風險與停手線；這不是執行授權，也不是連續安裝授權。

若你確認第三條候選命令可以執行，請按 `複製第三命令同意`。這張卡只同意或拒絕 `HERMES-INSTALL-003` 這一條命令，且實際命令必須和預覽完全一致；執行後要立刻停下回報結果，不可延伸成 `HERMES-INSTALL-004`、`HERMES-NEXT-001`、憑證填寫、Run now、排程或喚醒授權。

`HERMES-INSTALL-003` 執行後，請按 `複製第三命令結果`。它會要求確認實際命令是否和預覽一致、是否下載或安裝套件、是否修改 PATH/設定/檔案、是否出現憑證或越線行為，並把結果標成 `PASS` / `WAIT` / `PAUSE`。未完成這張回報前，不可列下一條或執行下一條。

完成第三命令結果回報後，請按 `複製第三命令判讀`。`PASS` 只代表 `HERMES-INSTALL-003` 乾淨，最多只能進入下一張指定安全卡，或請使用者決定是否回到下一條命令預覽；`WAIT` 只允許補資訊或只讀檢查；`PAUSE` 代表立刻停下排查。任何判讀都不是 `HERMES-INSTALL-004`、`HERMES-NEXT-001`、憑證、Run now、排程或喚醒授權。

完成第三命令判讀後，請按 `複製第三循環總結`。它會記錄 `HERMES-INSTALL-003` 的預覽、同意、結果、判讀、安全檢查與下一張安全卡；這份總結只做交接與覆盤，不會授權 `HERMES-INSTALL-004`、`HERMES-NEXT-001`、憑證、Run now、排程或喚醒。

若 `HERMES-INSTALL-003` 循環總結的最後判讀是 `PASS`，且你只想知道下一步可能命令，請按 `複製第四命令預覽`。它只允許 Codex 列出 `HERMES-INSTALL-004` 這一條候選命令、目的、風險與停手線；這不是執行授權，也不是連續安裝授權。

若你確認第四條候選命令可以執行，請按 `複製第四命令同意`。這張卡只同意或拒絕 `HERMES-INSTALL-004` 這一條命令，且實際命令必須和預覽完全一致；執行後要立刻停下回報結果，不可延伸成 `HERMES-INSTALL-005`、`HERMES-NEXT-001`、憑證填寫、Run now、排程或喚醒授權。

`HERMES-INSTALL-004` 執行後，請按 `複製第四命令結果`。它會要求確認實際命令是否和預覽一致、是否下載或安裝套件、是否修改 PATH/設定/檔案、是否出現憑證或越線行為，並把結果標成 `PASS` / `WAIT` / `PAUSE`。未完成這張回報前，不可列下一條或執行下一條。

完成第四命令結果回報後，請按 `複製第四命令判讀`。`PASS` 只代表 `HERMES-INSTALL-004` 乾淨，最多只能進入下一張指定安全卡，或請使用者決定是否回到下一條命令預覽；`WAIT` 只允許補資訊或只讀檢查；`PAUSE` 代表立刻停下排查。任何判讀都不是 `HERMES-INSTALL-005`、`HERMES-NEXT-001`、憑證、Run now、排程或喚醒授權。

完成第四命令判讀後，請按 `複製第四循環總結`。它會記錄 `HERMES-INSTALL-004` 的預覽、同意、結果、判讀、安全檢查與下一張安全卡；這份總結只做交接與覆盤，不會授權 `HERMES-INSTALL-005`、`HERMES-NEXT-001`、憑證、Run now、排程或喚醒。

若 `HERMES-INSTALL-004` 循環總結的最後判讀是 `PASS`，且你只想知道下一步可能命令，請按 `複製第五命令預覽`。它只允許 Codex 列出 `HERMES-INSTALL-005` 這一條候選命令、目的、風險與停手線；這不是執行授權，也不是連續安裝授權。

若你確認第五條候選命令可以執行，請按 `複製第五命令同意`。這張卡只同意或拒絕 `HERMES-INSTALL-005` 這一條命令，且實際命令必須和預覽完全一致；執行後要立刻停下回報結果，不可延伸成 `HERMES-INSTALL-006`、`HERMES-NEXT-001`、憑證填寫、Run now、排程或喚醒授權。

`HERMES-INSTALL-005` 執行後，請按 `複製第五命令結果`。它會要求確認實際命令是否和預覽一致、是否下載或安裝套件、是否修改 PATH/設定/檔案、是否出現憑證或越線行為，並把結果標成 `PASS` / `WAIT` / `PAUSE`。未完成這張回報前，不可列下一條或執行下一條。

完成第五命令結果回報後，請按 `複製第五命令判讀`。`PASS` 只代表 `HERMES-INSTALL-005` 乾淨，最多只能進入下一張指定安全卡，或請使用者決定是否回到下一條命令預覽；`WAIT` 只允許補資訊或只讀檢查；`PAUSE` 代表立刻停下排查。任何判讀都不是 `HERMES-INSTALL-006`、`HERMES-NEXT-001`、憑證、Run now、排程或喚醒授權。

`HERMES-INSTALL-001` 到 `HERMES-INSTALL-005` 是用來驗證安全規則的示例鏈。實際操作檯已收攏為 `Hermes 安裝逐條命令通用流程`，後續不要再新增 `HERMES-INSTALL-006`、`007` 這類專屬卡；每條命令都重複使用通用的 `命令預覽`、`逐條同意`、`命令回報`、`結果判讀` 與 `陪同總結`。

開始陪同安裝前，也請按 `複製陪同紀錄`。每個命令都要記錄：

- 目的。
- 預覽命令。
- 使用者是否同意執行。
- 結果摘要。
- 是否包含憑證或敏感資訊。

如果任何命令輸出含 API key、token、密碼，或可能建立正式任務、Run now、啟用排程、喚醒模型，立即停止並回報。

如果還沒準備跨過安裝線，請先按 `複製命令預覽`。它只要求 Codex 列出下一步命令、執行位置、目的、會修改什麼、風險與是否需要同意；在你逐條確認前，Codex 不應執行任何安裝、寫檔、下載、改 PATH、設定或喚醒動作。

如果你想更保守，請按 `複製命令表單`。這是第 1 階專用格式，只允許 Codex 用表格列出命令，不允許執行。表格會要求標出：命令類型、執行位置、會修改什麼、是否下載/安裝、是否需要憑證、風險，以及是否需要使用者逐條同意。任何碰到憑證、正式資料、issue、Run now、schedule trigger 或模型喚醒的命令，都必須標成 PAUSE。

進入第 2 階前，請按 `複製逐條同意`。這份紀錄只允許執行表內明確標為同意的單一命令；每執行一條就先記錄結果、是否含敏感資訊，再由使用者決定是否繼續下一條。沒有列在表內、沒有編號、或沒有逐條同意的命令都不可執行。

每執行完一條命令後，請按 `複製命令回報`。回報必須整理本次命令編號、執行位置、輸出摘要、是否修改系統或設定、是否出現 API key/token/密碼/完整 `.env`、是否碰到正式資料、Run now、schedule trigger 或 live run，並判斷為 `PASS`、`WAIT` 或 `PAUSE`。未完成這張回報前，不執行下一條命令；即使 `PASS`，也只能請使用者決定是否同意下一條。

讀完命令回報後，請按 `複製結果判讀`。`PASS` 只代表本條命令乾淨，不是下一條命令授權；`WAIT` 只允許補資訊或只讀檢查；`PAUSE` 代表立刻停下整理風險與復原建議。任何結果都不能自動填憑證、建立 issue、Run now、啟用 schedule trigger 或喚醒 Hermes。

若命令結果判讀是 `PASS`，請按 `複製 PASS 交接`。這份交接只代表本條命令乾淨；若要下一條命令，仍要回到命令預覽或請使用者逐條同意單一命令。`PASS` 不會延伸成後續命令同意，也不授權填憑證、建立 issue、Run now、啟用 schedule trigger 或喚醒 Hermes。

若命令結果判讀是 `WAIT` 或 `PAUSE`，請按 `複製 WAIT/PAUSE`。`WAIT` 只允許等待使用者補充資訊、做只讀檢查或回到命令預覽；`PAUSE` 只允許停下、整理非敏感錯誤摘要與復原建議。兩者都不是重試授權，也不是下一條命令授權。

若本輪安裝陪同要交接、換對話、重開機或收工，請按 `複製陪同總結`。它會整理本輪授權階級、執行環境、已執行命令數、最後判讀、敏感資訊檢查與下一張安全卡。這份總結不是下一條命令授權，不可用來連續執行命令。

若要關機或今天收工，請按 `複製收工交接`。它會記錄預覽狀態、最後使用的安全卡、最後判讀、明天第一步，以及仍未授權的事項。收工交接不是明天的安裝授權，也不是下一條命令授權；重開機後仍需先照開機/預覽復原 SOP 檢查。

隔天、重開機或換對話後，請先按 `複製開工接續`。它會要求先確認 Backend/Frontend、讀收工交接或陪同總結，並依 `PREVIEW BLOCKED`、`NO HANDOFF`、`PASS HANDOFF`、`WAIT/PAUSE HANDOFF` 或 `NEED NEW SCOPE` 決定下一張安全卡。這不是安裝授權、不是下一條命令授權，也不是喚醒授權。

若開工接續判斷是 `PASS HANDOFF`，請按 `複製下一命令預覽`。它只允許 Codex 列出一條下一步候選命令、執行位置、目的、會讀取或修改什麼、成功判斷與失敗停手線；這不是執行授權，也不能一次列多條命令要求同意。

若你確認 `HERMES-NEXT-001` 可以執行，請按 `複製單一命令同意`。這張卡只同意或拒絕這一條命令，且命令必須和預覽完全一致；執行後要立即停下回報結果，再進入單一命令結果回報或命令結果判讀。

`HERMES-NEXT-001` 執行後，請按 `複製單一命令結果`。它會要求確認實際命令與預覽是否一致、結果是 `PASS` / `WAIT` / `PAUSE`、是否修改系統或檔案、是否下載安裝，以及是否出現敏感資訊。未完成結果回報前，不可執行下一條命令。

完成結果回報後，請按 `複製單一命令判讀`。它會把 `HERMES-NEXT-001` 收斂成三種出口：`PASS` 只能請使用者決定是否回到下一條命令預覽；`WAIT` 只能補資訊或只讀檢查；`PAUSE` 則停下整理風險。任何判讀都不是下一條命令授權。

完成判讀後，請按 `複製單一循環總結`。它會記錄 `HERMES-NEXT-001` 的預覽、同意、結果、判讀、安全檢查與下一張安全卡；這份總結只做交接與覆盤，不會授權下一條命令。

貼出安裝授權前，請先按 `複製二次確認`。這份 GO / PAUSE 卡會確認：預覽是否健康、命令是否已先列出、安裝路線是否限於 WSL2/Ubuntu 或官方建議、是否沒有要求貼 API key/token/密碼，以及是否仍不建立喚醒 issue、不 Run now、不啟用 schedule trigger。只有二次確認為 GO，才進入安裝授權文字。

二次確認為 GO 後，請再按 `複製最終閘門`。最終閘門會確認 `office:verify`、最後交接、HERMES-NEXT-001 單一命令鏈、憑證邊界與喚醒邊界都乾淨；GO 也只代表可以請使用者決定是否貼出 `Hermes 安裝授權文字`，不是安裝授權或命令執行授權。

完成最終閘門後，請按 `複製閘門判斷`。它會把 GO / PAUSE、原因、缺項、下一個最小修補動作與仍禁止事項固定留痕。`GO` 仍只代表可以請使用者決定是否貼出安裝授權文字；`PAUSE` 也不是重試或跳過檢查的授權。

若閘門判斷是 `GO`，請按 `複製 GO 後交接`。它只交接到「使用者閱讀並決定是否貼出安裝授權文字」；在使用者明確貼出授權文字前，不安裝、不執行命令、不填憑證、不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。

若閘門判斷是 `PAUSE`，請按 `複製 PAUSE 修補`。它只允許記錄 PAUSE 原因、選一個最小修補動作，修補後回到最終閘門重新判斷；PAUSE 不是重試授權，也不是跳過檢查的授權。

若你只想逐步授權，不想一句「可以開始」被誤解成全部都能做，請按 `複製授權階梯`。階梯分成：

0. 只讀準備：只跑 `office:verify`、看 SOP、複製交接包。
1. 命令預覽：只列命令表，不執行。
2. 安裝陪同：使用者逐條同意後，才執行明確列出的安裝或檢查命令。
3. 設定檢查：使用者自己在 Hermes 設定位置處理憑證後，只回報非敏感狀態。
4. 沙盒喚醒測試：只用 Hermes Sandbox 員工與 Sandbox/Test issue 做第一次喚醒。

沒有明確授權階級時，只能停在第 0 階。第 4 階以前，不建立喚醒 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。

若你想先知道目前卡在哪一階，請按 `複製授權總控`。它會把第 0 到第 4 階、喚醒後覆盤與下一個最小安全動作整理成 Markdown；這只是狀態總控，不代表安裝授權、憑證授權、Run now 授權、排程授權或模型喚醒授權。

若要把目前狀態交接給 Codex 或明天繼續，請按 `複製最後交接`。它會把安裝前快照、檢查包、命令預覽、授權文字、陪同紀錄、下一個安全動作與停手線整理成一份 Markdown；這不是安裝授權，只是提醒接手者先預覽、先確認、不要跨線。

若只是要交接目前狀態，請按 `複製安裝前快照`。快照會列出已準備的檢查包、授權文字、陪同紀錄，以及仍然禁止自動安裝、填憑證、建立喚醒 issue、Run now、啟用排程或喚醒 Hermes。

Office 也會顯示 `Hermes 安裝前流程導引`，順序固定為：

1. 先跑 `pnpm run office:verify`。
2. 複製安裝前快照。
3. 複製安裝前檢查包。
4. 複製安裝授權，並由使用者決定是否跨過安裝線。
5. 複製陪同紀錄，逐步記錄每個命令。

任何一步卡住，都先停下，不往安裝或喚醒推進。

如果是第一次接觸 Hermes，請先按 `複製新手順序`。它會把 `複製總檢`、`複製安裝前快照`、`複製安裝前檢查包`、`複製命令預覽`、`複製逐條同意`、`複製授權階梯` 與 `複製最後交接` 排成 0 到 6 的閱讀路線。這份閱讀順序只用來降低新手迷路機率，不是安裝授權、設定授權或模型喚醒授權。

Office 也會顯示 `Hermes 安裝前風險判斷`，把預覽驗證、Bridge / CLI、模型與憑證、沙盒邊界、跨線授權整理成 GO/PAUSE。這個判斷只用來決定是否可以進入安裝陪同，不會自動安裝、不會填 API key、不會建立喚醒 issue，也不會喚醒 Hermes。

按 `複製風險判斷` 時，內容會分成：

- 目前訊號：每個 gate 的狀態、值與判讀。
- 可以做：健康檢查、複製檢查包、檢查非敏感輸出。
- 先不要做：不貼憑證、不建立任務、不 Run now、不啟用 trigger、不喚醒模型。
- 需要先補齊：所有尚未通過的風險項目。

Office 也會顯示 `Hermes 下一個安全動作`。它只會依序挑一件最小步驟：先確認 Bridge / CLI，再補模型與環境設定，再準備 Sandbox 員工與 Sandbox/Test 專案，最後才停在等待使用者授權。這個提示不是安裝許可，不會自動安裝、不會填憑證、不會建立任務，也不會喚醒 Hermes。

按 `複製下一步` 時，內容會列出：

- 狀態與下一步。
- 只做單一步驟。
- 先跑 `pnpm run office:verify`。
- 不貼 API key、token、密碼。
- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。
- 不安裝、不設定、不喚醒 Hermes，除非使用者明確授權。

如果你已經在 Hermes 自己的設定位置填好 model / provider / API key，請不要把密鑰或完整 `.env` 貼給 Codex。Office 提供 `Hermes 設定完成回報` 與 `複製設定回報`，讓你只回報非敏感狀態。

可以回報：

- WSL2/Ubuntu 是否可開啟。
- `scripts/hermes-wsl.cmd --version` 是否可回版本。
- Hermes model 是否已設定。
- Provider 名稱。
- API key 是否已在 Hermes 自己的設定位置填好：只填是 / 否 / 不確定。
- Test environment 結果摘要。

不要回報：

- API key、token、密碼。
- 完整 `.env` 內容。
- 含帳號、token 或內網敏感資訊的私人模型服務 URL。
- 正式客戶、公司或個人資料。

收到這份回報後，下一步也只做健康檢查或 Test environment；不建立喚醒 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。

Office 的 `Hermes 設定完成回報` 區塊也提供 `複製判讀規則`。使用者貼回設定完成回報後，Codex 只能判斷：

- WSL2/Ubuntu 是否可開啟。
- `scripts/hermes-wsl.cmd --version` 是否可回版本。
- Hermes model 是否已設定。
- Provider 名稱是否清楚。
- API key 是否已由使用者自己放在 Hermes 設定位置。
- Test environment 是 pass、warn、fail 或尚未跑。

判斷結果只能是 `GO read-only check`、`WAIT for missing report` 或 `PAUSE`。若回報包含 API key、token、密碼、完整 `.env`、含憑證 URL/header/log，或要求 Codex 登入、填 key、改設定、處理 OAuth、建立 issue、Run now、啟用 schedule trigger 或喚醒 Hermes，必須直接 `PAUSE`。

若判斷是 `GO read-only check`，先按 `複製只讀前確認`。這張確認卡會再次檢查：

- 使用者已自行處理 provider/model/API key，Codex 沒有登入、填 key 或處理 OAuth。
- 已貼 `Hermes 設定完成回報` 或等效非敏感摘要。
- 回報中沒有 API key、token、密碼、完整 `.env`、含憑證 URL/header/log 或正式資料。
- 本次只看 Office preview、Hermes bridge、Hermes status 與 Test environment 非敏感摘要。
- 本次仍禁止登入、OAuth、建立或查看 key、安裝、下載、寫檔、改 PATH、改設定、建立 issue、Run now、啟用 schedule trigger、打開 heartbeat scheduler 或喚醒 Hermes。

只有這張確認卡也能判定 `GO`，才往下一步 `複製只讀檢查`。

若判斷是 `GO read-only check`，同區塊可用 `複製只讀檢查`。這份請求只允許：

- 確認 Office preview 的 Backend OK / Frontend OK。
- 確認 Hermes bridge 是否可回版本。
- 確認 Hermes status 沒有 active sessions、scheduled jobs 或正在喚醒的任務。
- 讀取 Test environment 的非敏感摘要。

這仍然不是設定、執行或喚醒授權。不可讀出或整理 API key、token、密碼、完整 `.env`；不可登入、OAuth、安裝、下載、寫檔、改 PATH、改設定、建立 issue、Run now、啟用 schedule trigger 或喚醒 Hermes。

只讀檢查完成後，先用 `複製結果交接`。這份交接表只允許貼：

- Preview health：OK / blocked / 未檢查。
- Hermes bridge：OK / blocked / 未檢查。
- Hermes status：jobs 0 / sessions 0 / 有活動需暫停 / 未檢查。
- Test environment：pass / warn / fail / 未檢查。
- Test environment 非敏感摘要。

不要貼 API key、token、密碼、完整 `.env`、含憑證 URL/header/log、完整 raw log、截圖、終端輸出或正式資料。若結果交接出現敏感資訊，立即 `PAUSE`，不要整理、重貼或擴散。

結果交接完成後，請用 `複製結果判讀`。判讀結果只能是：

- `PASS`：Preview、bridge、status 與 Test environment 都乾淨；下一步也只能準備第 4 階喚醒前檢查，不代表可以直接喚醒。
- `WARN`：有非阻塞警告或 Test environment warn；先整理原因與只讀修正建議。
- `FAIL`：preview、bridge 或 Test environment 失敗；先停下排查。
- `PAUSE`：出現 API key、token、密碼、完整 `.env`、含憑證 URL/header/log、active sessions、scheduled jobs、running task 或任何喚醒要求。

即使結果是 `PASS`，也不能自動建立 issue、不能 Run now、不能啟用 schedule trigger、不能喚醒 Hermes、不能接正式專案；只能建議下一步複製第 4 階喚醒前檢查，並等使用者另行明確授權。

若結果判讀是 `PASS`，請先按 `複製 PASS 後交接`。這份交接卡會把 PASS 的意義鎖定為：

- Preview、Hermes bridge、Hermes status 與 Test environment 都乾淨。
- Hermes status 沒有 active sessions、scheduled jobs 或喚醒中的任務。
- Test environment 摘要不含密鑰、完整 `.env` 或正式資料。
- 下一步只允許複製第 4 階喚醒前檢查表。
- 不自動建立 issue、不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler、不喚醒 Hermes。

`PASS` 不是安裝授權、不是憑證授權、不是 Run now 授權，也不是喚醒授權。真正喚醒仍要等使用者另行貼出第 4 階一次性喚醒授權。

準備進入第 4 階前，請按 `複製第 4 階入口`。這份交接卡會再次確認：

- 只讀結果判讀是 `PASS`。
- 已完成 `複製 PASS 後交接`。
- 沒有 active sessions、scheduled jobs、running task、recovery issue 或喚醒中的任務。
- 沒有 API key、token、密碼、完整 `.env`、含憑證 URL/header/log 或正式資料。
- 第 4 階目前只允許檢查 Hermes Sandbox/Test 員工、Sandbox/Test 專案與使用者 Sandbox/Test 確認。

若入口交接是 `GO`，下一步才按 `複製喚醒前檢查`。若是 `WAIT`，只補 Sandbox/Test 條件；若是 `PAUSE`，停止處理，不建立 issue、不 Run now、不排程、不喚醒。

若入口交接或喚醒前檢查是 `WAIT`，請按 `複製第 4 階 WAIT`。這份補齊包只允許：

- 建立或確認 Hermes Sandbox/Test 員工。
- 建立或確認 Sandbox/Test 專案。
- 勾選使用者 Sandbox/Test 確認。
- 重新跑只讀檢查或 Test environment 的非敏感摘要。
- 重新複製第 4 階入口交接或喚醒前檢查表。

它仍然禁止預填 issue 草稿、代按建立、Run now、schedule trigger、heartbeat scheduler、連續喚醒、正式專案、正式資料或喚醒 Hermes。補齊後先回來重新按 `複製第 4 階入口` 與 `複製喚醒前檢查`。

若你要進入第 3 階，請在 Office 按 `複製設定檢查`。這份檢查表只允許整理非敏感設定狀態與只讀測試結果，例如 provider、model、API key 是否已在 Hermes 自己的設定位置填好、`.env` 是否存在，以及 Test environment 結果摘要。它不代表可以建立 issue、Run now、啟用 schedule trigger 或喚醒 Hermes；如果需要任何新命令，先回到第 1 階命令預覽表單。

技能同步也要分兩層看：`desired skills 已保存` 只代表員工設定裡看得到技能；`runtime skill loading 已驗證` 才代表 Hermes/local model 接 Sandbox/Test issue 時，回覆中能看出它真的使用指定技能。Office 的 Hermes 區塊提供 `複製技能交接`，可把 starter skills、Hermes Sandbox 員工、Sandbox/Test 專案與 runtime readiness 整理成 Markdown。這份交接不會建立 issue、不會 Run now、不會啟用排程，也不會喚醒 Hermes。

2026-05-11 已補上後端注入路徑：`hermes_local` execute 會把 desired Paperclip runtime skills 帶入 Hermes 可讀的任務內容。若 agent 沒有自訂 promptTemplate，skills 會附加到 Sandbox/Test issue 的 `taskBody`，保留 Hermes 預設任務流程；若 agent 有自訂 promptTemplate，skills 會插入該 promptTemplate。這只證明 Paperclip 會交付技能內容，真正完成仍要等 Sandbox/Test issue 回覆中留下「使用了哪些 skills」的證據。

2026-05-11 `AI-98227` 回覆已提供第二層的一半證據：Hermes 真的在第二個 Sandbox/Test issue 被喚醒、收到任務並留下 skills 類回覆；但它列出的仍是通用工具名稱，不是 Paperclip runtime skill key。下一次補強應先改 prompt，明確要求 Hermes 回覆 `paperclipSkillSync.desiredSkills` 中的 exact keys，例如 `paperclipai/paperclip/paperclip`、`paperclipai/paperclip/paperclip-create-agent` 與公司 skill key；補強前不要再用新的喚醒來重測。

2026-05-11 已補強 runtime skill key 回覆提示：`hermes_local` 現在會要求 Hermes 在完成留言中新增 `Paperclip runtime skills` 段落，逐字列出 exact skill keys，並標記 used 或 visible but not used；不得只回 `terminal`、`patch`、`search_files`、`write_file` 這類通用工具名。這只是提示與測試補強，還不是新的模型喚醒證據；下一次真測仍需重新取得一次性 Sandbox/Test 授權。

2026-05-11 已準備下一張 exact skill key 驗證 issue：`AI-98228`，標題為 `[Sandbox/Test] Hermes exact runtime skill key proof - no Run now`。它位於 `Virtual Office Sandbox`，指派給 `Hermes Sandbox Engineer`，狀態保持 `backlog`；建立後確認 `Hermes Sandbox Engineer` 仍為 `paused/manual`、heartbeat false、無留言、無 checkout run、無 active run。這張 issue 只等待未來使用者另行貼出明確一次性授權句，不可因「繼續」或「下一步」直接喚醒。

2026-05-11 `AI-98228` exact skill key 驗證喚醒已用完。使用者明確授權後，checkout 產生唯一 run `152b163d-619a-443e-ab7f-2665a525198f`，run 成功、exit code 0、Hermes session `20260511_182129_cde8ee`，留言 `717d3ecb-99c1-4f1c-bdae-50bd21158ed1` 已寫回 issue。完成後已暫停 `Hermes Sandbox Engineer`，`AI-98228` 已收尾為 `done`，active run 為空，heartbeat scheduler false。結果未通過：Hermes 沒有回覆 `Paperclip runtime skills` 段落，也沒有 exact skill keys；run log 也找不到 `Paperclip Runtime Skills`、`Completion comment requirement`、`exact skill keys` 或 `paperclipai/paperclip`，代表 runtime skill prompt 沒有進到本次模型輸入。下一步先重啟後端載入 prompt 補強，再新增只讀 preflight 確認 prompt 會進入任務內容；未完成前不要再建立新的喚醒授權。

2026-05-11 已新增並通過 `pnpm run office:hermes-preflight` 只讀 preflight。它只讀 backend health、Hermes Sandbox Engineer 與 skills snapshot，使用同一個 runtime prompt builder 確認下一次 Hermes 輸入會注入 `Paperclip Runtime Skills`、`Completion comment requirement`、`exact skill keys`，且 7 個 desired skill keys 都以 exact key 出現在 prompt 中。這個結果只代表可以進入下一張 Sandbox/Test issue 的建立與授權準備，不代表已授權喚醒；仍禁止 Run now、schedule trigger、heartbeat scheduler、正式專案、正式資料與連續喚醒。

2026-05-11 已建立下一張 Sandbox/Test 驗證 issue `AI-98229`，標題為 `[Sandbox/Test] Hermes runtime skill prompt preflight proof - no Run now`。建立後已確認 issue 為 backlog、無留言、active run 為空，`Hermes Sandbox Engineer` 仍為 paused/manual，Backend health OK。此 issue 只用來驗證 preflight 後的下一次模型輸入與回覆是否真的包含 exact Paperclip runtime skill keys；尚未授權喚醒，不能因「繼續」或「下一步」直接 checkout/wakeup。

2026-05-11 `AI-98229` runtime skill prompt proof 喚醒已用完。使用者明確授權後，checkout 產生唯一 run `6e25b796-5fe8-49ef-ac8f-b696f267d900`，run 成功、exit code 0、Hermes session `20260511_185425_434f38`，留言 `712bc46e-a272-473e-a073-c878e377470d` 已寫回 issue。完成後已暫停 `Hermes Sandbox Engineer`，`AI-98229` 已收尾為 `done`，active run 為空。結果仍未通過：Hermes 回覆與 run log 都沒有 `Paperclip Runtime Skills`、`Completion comment requirement`、`exact skill keys` 或 exact Paperclip skill keys。覆盤後修正 `hermes_local` execute 路徑，讓 runtime skill prompt 使用 `adapterConfig + runtime config` 組裝，避免漏掉員工 adapterConfig 裡的 `paperclipSkillSync.desiredSkills`；測試已覆蓋這條真實路徑。這次授權已用完，修正後仍需重新建立新的 Sandbox/Test issue 與新的明確一次性授權，才可再測。

2026-05-11 已建立下一張 Sandbox/Test 驗證 issue `AI-98230`，標題為 `[Sandbox/Test] Hermes fixed runtime skill prompt proof - no Run now`。建立前 `pnpm run office:hermes-preflight` 通過；建立後已確認 issue 為 backlog、無留言、active run 為空，`Hermes Sandbox Engineer` 仍為 paused/manual，Backend health OK。此 issue 只用來驗證修正後的真實 Hermes execute 路徑是否會把 exact Paperclip runtime skill keys 帶進模型輸入；尚未授權喚醒，不能因「繼續」或「下一步」直接 checkout/wakeup。

2026-05-11 `AI-98230` fixed runtime skill prompt proof 喚醒已用完。使用者明確授權後，checkout 產生唯一 run `941dcbdf-e330-4f69-874e-d7d2808eaf11`，run 成功、exit code 0、Hermes session `20260511_195011_5d1b55`，留言 `796676a9-9b48-4e71-ba85-a357baa3be32` 已寫回 issue。完成後已暫停 `Hermes Sandbox Engineer`，`AI-98230` 已收尾為 `done`，active run 為空。結果仍未通過：Hermes 回覆仍未列 exact skill keys，且語氣顯示它沒有看到具體 issue/task context。覆盤後修正 `hermes_local`：不再把 custom promptTemplate 直接傳給 Hermes，改把 auth guard、runtime skill prompt 與原自訂員工說明移入 `taskBody`，讓 Hermes 保留內建 Paperclip 任務上下文。這次授權已用完，修正後仍需重新建立新的 Sandbox/Test issue 與新的明確一次性授權，才可再測。

2026-05-11 已建立下一張 Sandbox/Test 驗證 issue `AI-98231`，標題為 `[Sandbox/Test] Hermes taskBody runtime skill prompt proof - no Run now`。建立前 `pnpm run office:hermes-preflight` 通過，並顯示 injection target 為 `taskBody (custom promptTemplate moved into task body)`；建立後已確認 issue 為 backlog、無留言、active run 為空，`Hermes Sandbox Engineer` 仍為 paused/manual，Backend health OK。此 issue 只用來驗證 taskBody prompt routing 修正後 Hermes 是否同時看見 Paperclip task context 與 exact runtime skill keys。

2026-05-11 `AI-98231` taskBody runtime skill prompt proof 喚醒已用完。使用者明確授權後，checkout 產生唯一 run `ef52bc26-20f3-40ac-97c6-cfd27bcebd50`，run 成功、exit code 0、Hermes session `20260511_201500_55b709`，留言 `05a64d8d-93d8-48e5-9ab1-928c66fbc7f1` 已寫回 issue。完成後已暫停 `Hermes Sandbox Engineer`，`AI-98231` 已收尾為 `done`，active run 為空。結果仍未通過：Hermes 回覆沒有 `Paperclip runtime skills` 段落，也沒有 exact `paperclipai/paperclip/...` 或 `company/...` key；run log 也未找到 runtime prompt 標記。覆盤後修正 `hermes_local`：當 heartbeat 只把 issue 任務放在 `context.paperclipIssue` / `context.paperclipTaskMarkdown`，而 runtime config 沒有 `taskId`、`taskTitle`、`taskBody` 時，wrapper 會先把 Paperclip issue context 補進 Hermes 會讀取的 task config，再附加 auth guard、runtime skills 與員工自訂說明。這次授權已用完，修正後仍需重新建立新的 Sandbox/Test issue 與新的明確一次性授權，才可再測。

2026-05-11 已建立下一張 Sandbox/Test 驗證 issue `AI-98232`，標題為 `[Sandbox/Test] Hermes task config fallback proof - no Run now`。建立前 `pnpm run office:hermes-preflight` 通過，並顯示 injection target 為 `taskBody (custom promptTemplate moved into task body; Paperclip issue context fallback enabled)`；建立後已確認 issue 為 backlog、comments 為空、active run 為空、checkout run 為空，`Hermes Sandbox Engineer` 仍為 paused/manual。此 issue 只用來驗證 AI-98231 後修正的 task config fallback 是否能讓 Hermes 同時看見 Paperclip task context 與 exact runtime skill keys；尚未授權喚醒。

2026-05-11 `AI-98232` task config fallback proof 喚醒已用完。使用者明確授權後，checkout 產生唯一 run `7aed7835-6a18-427e-9f84-22f1c01e8068`，run 成功、exit code 0、Hermes session `20260511_210524_c2e7ee`，留言 `22254972-838f-48a6-87de-83c160090158` 已寫回 issue。完成後已暫停 `Hermes Sandbox Engineer`，`AI-98232` 已收尾為 `done`，active run 為空。結果仍未通過：Hermes 回覆仍表示「沒有看到任何上下文」，沒有 `Paperclip runtime skills` 段落，也沒有 exact `paperclipai/paperclip/...` 或 `company/...` key；run log 也未找到 runtime prompt 標記。覆盤後修正 `hermes_local`：不再因 local agent JWT / `authToken` 缺席而跳過 taskBody/runtime skills 補強；Paperclip task context 與 runtime skills 會一律注入，只有在 `authToken` 或顯式 `PAPERCLIP_API_KEY` 存在時才加入 API 寫入授權提示。這次授權已用完，修正後仍需重新建立新的 Sandbox/Test issue 與新的明確一次性授權，才可再測。

2026-05-11 已建立下一張 Sandbox/Test 驗證 issue `AI-98233`，標題為 `[Sandbox/Test] Hermes authToken-independent runtime prompt proof - no Run now`。建立前 `pnpm run office:hermes-preflight` 通過，並顯示 injection target 為 `taskBody (custom promptTemplate moved into task body; Paperclip issue context fallback enabled)`；建立後已確認 issue 為 backlog、comments 為空、active run 為空、checkout run 為空，`Hermes Sandbox Engineer` 仍為 paused/manual。此 issue 只用來驗證 AI-98232 後修正的 authToken-independent prompt injection 是否能讓 Hermes 同時看見 Paperclip task context 與 exact runtime skill keys；尚未授權喚醒。

## 第 2 步：安裝 Hermes CLI

Paperclip adapter 內建 README 仍寫著 `pip install hermes-agent`，但 2026-05-07 實測 PyPI 找不到這個套件；官方 Hermes Agent 安裝文件則寫明 Native Windows 不支援，Windows 要走 WSL2。

Windows 建議先確認 WSL2：

```powershell
wsl.exe -l -v
```

確認有 Ubuntu / Version 2 後，在 WSL2 內使用官方安裝器：

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

安裝後在 WSL2 內確認：

```bash
hermes --help
```

如果 Windows 端 Office 仍顯示找不到 `hermes`，先不要喚醒 agent。這是預期狀態，因為 Paperclip server 目前跑在 Windows，而 Hermes 安裝在 WSL2；需要再做一個 Windows 到 WSL2 的安全橋接。

常見 Windows 檢查方向：

- `pip install hermes-agent` 找不到套件：不要反覆重試，改走官方 WSL2 安裝路線。
- WSL2 內 `hermes --help` 可用，但 Office 仍找不到：先補橋接，不要直接喚醒。
- 不確定 Hermes 安裝在哪裡：先在 WSL2 內跑 `which hermes`，把結果記進驗收紀錄。
- 不確定 Windows 是否能呼叫 WSL Hermes：先只做 `Test environment`，不要指派任務。

## 第 3 步：設定模型憑證

Hermes Agent 支援多個 provider，例如 Anthropic、OpenRouter、OpenAI、Nous、ZAI、Kimi Coding、MiniMax 等。

新手建議先只設定一個 provider，並記錄：

- 使用哪個 provider。
- 使用哪個 model。
- API key 放在哪裡。
- 是否能用 Hermes CLI 自己跑一個最小測試。

不要把 API key 寫進可公開文件、截圖、issue 或 prompt template。

設定前請先做 provider / model 選擇判斷：

| 選項 | 適合情境 | 注意 |
| --- | --- | --- |
| OpenRouter | 想先用單一入口測多種模型 | 只在 Hermes 自己的設定位置放 API key，不貼到 Office 或 issue。 |
| OpenAI / Codex | 已有 OpenAI 或 Codex 可用帳號 | 若要登入或授權，使用者自行在 Hermes 流程處理，不把 token 貼給 Codex。 |
| Anthropic | 想用 Claude 系列模型 | 確認模型名稱與 provider 設定由 Hermes 接受。 |
| Nous Portal | 想走 Hermes / Nous 原生路線 | OAuth 或登入流程只在 Hermes 自己的介面完成。 |
| Qwen / Kimi / MiniMax / Z.AI | 已有對應帳號或區域服務 | 先確認可用模型與憑證存放位置，不把地區性私密 URL 貼出。 |

新手建議選擇原則：

- 先選一個你已經有帳號或額度的 provider。
- 先選一個成本可控、回覆穩定、適合文字任務的 model。
- 先不要同時設定多個 provider，避免錯誤訊息變複雜。
- 不要為了測試把正式客戶、公司或私人資料放進 prompt。
- 設定完成後只回報 provider 名稱、model 名稱、是否已在 Hermes 位置填好 key，以及 Test environment 摘要。

若不確定 provider / model，請先停下來整理非敏感選項，不要登入、不要貼 key、不要建立任務、不要喚醒 Hermes。

Office 的 `Hermes provider/model 設定前判斷` 也提供 `複製選擇表`。這份表只收：

- 想先使用的 provider。
- 想先使用的 model。
- 是否已有帳號或額度。
- 是否準備由使用者自己在 Hermes 設定位置填 API key。
- 是否需要 Codex 先只列設定命令預覽。

這份表不收 API key、token、密碼、完整 `.env`、含憑證的 URL/header/log 或正式資料。若需要任何命令，先回到第 1 階命令預覽表單；不要登入、不要填 key、不要建立 issue、不要 Run now、不要啟用 schedule trigger、不要喚醒 Hermes。

Office 同區塊也提供 `複製檢查規則`。當使用者把選擇表貼回來時，Codex 只檢查：

- provider 是否已填。
- model 是否已填。
- 是否已有帳號或額度。
- 是否由使用者自己在 Hermes 設定位置填 API key。
- 是否需要先列第 1 階命令預覽。

判斷結果只能是 `GO to command preview`、`WAIT for user self-setup` 或 `PAUSE`。若內容出現 API key、token、密碼、完整 `.env`、登入/OAuth 代辦要求、Run now、建立喚醒 issue、啟用 schedule trigger 或喚醒 Hermes，必須直接 `PAUSE`。Codex 不登入、不填 key、不執行命令、不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes。

若檢查結果是 `GO to command preview`，同區塊可用 `複製命令預覽`。這份模板只要求 Codex 列出 provider/model 設定前可能需要的命令或人工步驟，並標示：

- 命令或人工步驟摘要。
- 目的。
- 是否會下載、寫檔、改設定、登入或碰憑證。
- 風險。
- 是否需要使用者逐條同意。

這份命令預覽仍然不是執行授權。任何代填 API key、token、密碼、完整 `.env`、登入/OAuth、建立密鑰、下載/安裝/寫檔/改 PATH/改設定、建立 issue、Run now、啟用 schedule trigger 或喚醒 Hermes，都必須停下來等使用者逐條明確同意。

當你準備自己進入 Hermes 的安全設定位置時，可按 `複製自行設定陪跑`。這張陪跑卡只協助你逐項確認：

- 使用者自己選 provider 與 model。
- 使用者只在 Hermes 自己的設定位置輸入 API key、token 或密碼。
- 若畫面顯示密鑰，先遮住或不要貼出，只回報「已設定 / 未設定 / 不確定」。
- Codex 只解釋非敏感欄位、協助判斷不含憑證的錯誤訊息、版本、bridge 狀態與 Test environment 摘要。
- Codex 不登入、不處理 OAuth、不建立或查看 API key、不代填 provider/model/key、不改設定檔、不寫入憑證。

自行設定完成後，回 Office 使用 `複製設定回報`，只貼 provider、model、API key 是否已由使用者自己放在 Hermes 安全設定位置，以及不含憑證的錯誤摘要。仍然不建立 issue、不 Run now、不啟用排程、不喚醒 Hermes。

如果剛設定完但還不確定要怎麼回報，先按 `複製設定後交接`。這份交接卡只允許回報：

- provider 名稱與 model 名稱。
- API key 是否已由使用者自己設定。
- Hermes bridge 是否可回版本。
- Test environment 是否已跑。
- 不含憑證的錯誤摘要。

Codex 只能判斷欄位是否完整、是否可整理成 `複製設定回報`、是否可進入判讀規則或只讀檢查。若交接內容包含 API key、token、密碼、完整 `.env`、含憑證 URL/header/log，或需要登入、OAuth、建立 key、代填 key、修改設定檔、建立 issue、Run now、排程或喚醒 Hermes，必須停下。

建議先把這些資訊記在本機私有筆記，不要放進 Git、公開 README 或開源截圖。開源文件只需要描述「需要一組模型憑證」，不需要放實際 key。

Windows + WSL2 目前建議設定方式：

```powershell
wsl.exe -d Ubuntu -- hermes model
```

如果想先只看狀態，不進入互動設定：

```powershell
scripts\hermes-wsl.cmd status
```

設定完成後，回到 Office 按 `重新檢查`。通過標準是 Hermes gate 不再提示 model、`.env` 或 API key 缺少。

## 第 4 步：建立 Hermes 沙盒員工

在 Virtual Office 的 `Hermes / local model gate` 按 `建立 Hermes 草稿`。

按下建立草稿前，建議先按 `複製草稿確認包`。它會列出即將帶到新員工頁的 name、title、role、adapter、command、starter skills 與 prompt 草稿。這份確認包只用來人工核對，不會建立員工、不會安裝 Hermes、不會填 API key，也不會喚醒模型。

送出建立前先檢查：

- 名稱包含 `Sandbox` 或 `Test`。
- Adapter type 是 `hermes_local`。
- Command 是 `scripts/hermes-wsl.cmd`，或填入你本機可穩定呼叫 Hermes CLI 的完整路徑。
- Model 是你已設定好的模型。
- Starter skills 只勾測試要用的項目。
- 建立員工頁有顯示 `Hermes Sandbox 建立前確認`，並提醒不要把 API key、token、密碼寫進 prompt、skills 或 issue。
- Prompt 只允許先處理 Sandbox/Test 任務，並禁止修改檔案、正式任務或員工狀態。

先不要把它設為正式專案主管。

建立完成後，回到 Office 的 `Hermes 建立後檢查`：

- 確認已找到 Hermes Sandbox/Test 員工。
- 需要交接目前狀態時，先按 `複製建立後回報`，把 Sandbox 員工、starter skills、正式主管與環境測試狀態貼回 Codex 或驗收紀錄。
- 按 `預選 Hermes skills`，只會打開技能精靈並預選三個 starter skills；最後仍需手動按 `同步技能`。
- 確認 `Starter skills` 顯示三個都已同步到 Hermes Sandbox 員工。
- 確認 `技能載入驗收準備度` 的 `Adapter skills`、`Starter skills`、`Sandbox/Test` 與 `下一步` 四格；這裡只讀判斷，條件未齊前不要建立 issue 或喚醒模型。
- 確認 `Hermes 開始設定判斷` 顯示預覽驗證、adapter、環境測試、沙盒資料與 starter skills 都可接受；若總判斷仍是 `先暫緩`，只做設定與檢查，不建立喚醒 issue、不 Run now。
- 需要交接時可按 `複製開始判斷`，把前置檢查與安全邊界貼回 Codex 或驗收紀錄。
- 要交接 WSL2 設定步驟時，可按 `複製設定指引`。它只複製狀態、命令與安全提醒，不會自動安裝、不會填 API key、不會喚醒模型。
- 即使前置條件都通過，仍需由使用者手動勾選 Sandbox/Test 確認；沒有勾選前，`預填 issue 草稿` 不可用。
- 確認 `正式主管` 不是可用狀態；第一次喚醒前不要讓 Hermes 管理正式專案。
- 確認 `環境測試` 通過後，再往下一步走。

## 第 5 步：環境測試

建立 Hermes 員工後，進入員工設定，先按 `Test environment`。

通過標準：

- 找得到 Hermes CLI。
- 找得到模型設定。
- 沒有缺少 API key 或 provider 設定。
- 錯誤訊息可以看懂，且沒有要求修改正式資料。

如果環境測試失敗：

1. 不要喚醒 Hermes。
2. 記下錯誤訊息。
3. 檢查 command、model、provider、API key 與工作目錄。
4. 修好後重新測一次。

## 第 6 步：沙盒真喚醒

只有前面都通過後，才建立一個沙盒 issue 指派給 Hermes。

建立前四個門檻：

| 門檻 | 通過標準 |
| --- | --- |
| 環境狀態 | Office 的 Hermes Test environment 不再顯示缺 model、`.env` 或 API key。 |
| 沙盒員工 | 至少一位 `hermes_local` 員工名稱或職稱含 `Sandbox`、`Test`、`沙盒` 或 `測試`。 |
| 沙盒專案 | issue 掛到 Sandbox/Test 專案，不掛正式專案。 |
| 結束判斷 | 知道測完要確認回覆紀錄、員工狀態與 recovery issues。 |

建議第一個任務很小：

```text
## Hermes Sandbox First Wake-up

請只做這個沙盒任務，不修改任何正式資料。

### 任務
1. 回覆你已收到任務。
2. 列出你能看到的公司、專案與任務標題。
3. 說明你目前可用的 skills 或工具能力。
4. 列出下一步你會先檢查哪些安全邊界。

### 限制
- 不要修改檔案。
- 不要建立正式任務。
- 不要停用、刪除或改名任何員工。
- 不要讀取或回覆任何 API key、token、密碼或私密設定。
- 如果環境缺少 model、provider 或 API key，請只回報缺少項目，不要重試多次。

### 通過標準
- Hermes 留下一段可覆盤回覆。
- 員工沒有卡在 running/error。
- 沒有大量 recovery issues。
- 使用者可以看懂下一步該設定什麼。
```

Office 的 `第一次沙盒喚醒計畫` 也可以複製同一份模板。它只會把文字放到剪貼簿，不會自動建立 issue，也不會喚醒 agent。

當四個門檻都通過後，Office 會開放 `預填 issue 草稿`。這個按鈕只會打開建立 issue 對話框並預填：

- 標題：`Hermes Sandbox First Wake-up`
- 描述：第一次沙盒喚醒模板
- 專案：第一個 Sandbox/Test 專案
- 負責人：第一位 Hermes Sandbox/Test 員工

它仍然需要使用者在建立 issue 對話框最後按建立；不會自動建立 issue，也不會自動喚醒 Hermes。

若第 4 階判讀已是 `READY TO PREFILL`，先按 `複製預填交接`，再打開預填草稿。這份交接只允許打開與檢查 Sandbox/Test issue 草稿；草稿打開後只核對標題、描述、Sandbox/Test 專案、Hermes Sandbox/Test 負責人與是否沒有密鑰或正式資料。它不是建立授權、不是 Run now 授權、不是排程授權，也不是喚醒授權。

打開預填草稿後，請先按 `複製建立前確認`。這份確認表只檢查草稿內容，不代表 Codex 可以代按建立：

- 標題應為 `Hermes Sandbox First Wake-up`。
- 專案必須是 Sandbox/Test 專案。
- 負責人必須是 Hermes Sandbox/Test 員工。
- 描述只要求回覆上下文、skills、環境狀態與安全邊界。
- 描述不可包含 API key、token、密碼、完整 `.env`、私密 URL、正式客戶或公司資料。
- 不勾選 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler。

判斷只能是 `READY TO CREATE MANUALLY`、`WAIT` 或 `PAUSE`。即使是 `READY TO CREATE MANUALLY`，最後建立也必須由使用者自己手動按；Codex 不代按建立、不 Run now、不啟用排程、不連續喚醒、不接正式專案。

若判斷是 `READY TO CREATE MANUALLY`，請先按 `複製手動建立交接`。這份交接卡只把決定權交回使用者：使用者若選擇建立，只能自己在建立 issue 對話框按建立；Codex 不代按、不送出表單、不 Run now、不啟用 schedule trigger、不打開 heartbeat scheduler、不喚醒 Hermes。建立後第一步仍是 `複製建立後觀察`。

手動建立 Sandbox/Test issue 之後，請按 `複製建立後觀察`。這份觀察表只確認：

- issue 仍掛在 Sandbox/Test 專案。
- 負責人仍是 Hermes Sandbox/Test 員工。
- issue 描述沒有密鑰、完整 `.env`、私密 URL、正式客戶或公司資料。
- 沒有自動 Run now、沒有啟用 schedule trigger、沒有打開 heartbeat scheduler。
- Hermes 員工沒有卡在 running/error。
- 沒有 queued/running live runs 或新增 recovery issues。

判斷只能是 `CLEAN`、`WAIT` 或 `PAUSE`。即使是 `CLEAN`，也不代表可以自動 Run now 或喚醒 Hermes；若要真正喚醒，必須由使用者另行明確授權。

若判斷是 `CLEAN`，請先按 `複製 CLEAN 交接`。這份交接卡只確認 CLEAN 代表「可準備一次性喚醒授權文字」，不代表已經取得喚醒授權。沒有使用者另行貼出一次性授權句前，Codex 仍不可喚醒 Hermes、不可 Run now、不可啟用 schedule trigger、不可連續喚醒，也不可接正式專案。

當建立後觀察是 `CLEAN`，且你真的準備進入第一次 Sandbox/Test 喚醒時，請按 `複製喚醒授權`。這段文字是第 4 階的一次性授權，只允許：

- 針對單一 Hermes Sandbox First Wake-up issue。
- 只讓 Hermes Sandbox/Test 員工回覆該 Sandbox/Test issue。
- 只要求回覆收到任務、可見上下文、可用 skills、環境狀態與下一步安全檢查。
- 完成後立即回到喚醒後檢查面板與覆盤回報。

本輪已建立的目標 issue 是 `AI-97978`。因此第一次真測授權必須明確點名 `AI-97978`、`Hermes Sandbox Engineer`、`一次性 Sandbox/Test 喚醒` 與 `完成後立刻停下覆盤`。若授權句只寫「請繼續」、「下一步」、「可以」、「照你建議」或沒有點名 `AI-97978`，一律視為 `WAIT`，只可回到授權句檢查，不可喚醒 Hermes。

它仍然禁止正式專案、正式資料、第二個 issue、連續喚醒、Run now、schedule trigger、heartbeat scheduler、讀取或整理密鑰、改設定、安裝或下載。若找不到單一 Sandbox/Test issue、負責人不是 Hermes Sandbox/Test 員工、出現 running/error、live runs、recovery issues 或憑證疑慮，就停下覆盤。

使用者貼出授權句前，請先按 `複製授權句檢查`。這份檢查卡只判斷授權句是否明確，不是喚醒授權。只有完整包含「我同意第 4 階」、「只對單一 Sandbox/Test issue」、「一次 Hermes Sandbox 喚醒」與「完成後立刻停下覆盤」時，才可判斷為 `ACCEPT`。像「可以」、「繼續」、「幫我跑」、「你決定」、「直接做」或「喚醒 Hermes 看看」都只能視為模糊句，不能喚醒。

若授權句檢查是 `ACCEPT`，請再按 `複製 ACCEPT 交接`。這份交接卡只允許針對單一 Sandbox/Test issue 做一次 Hermes Sandbox 喚醒前最後確認；它不擴張成 Run now、schedule trigger、heartbeat scheduler、連續喚醒、第二個 issue、正式專案或正式資料授權。完成後必須立刻回到喚醒後檢查面板與覆盤回報。

在真正喚醒前，請按 `複製喚醒前最後確認`。這張卡只做最後只讀核對：單一 Sandbox/Test issue、單一 Hermes Sandbox/Test 員工、員工不是 running/error、沒有 queued/running live runs、沒有未覆盤 recovery issues、沒有密鑰或正式資料。任一項不通過就停下，不喚醒。

最後確認全通過後，請按 `複製喚醒執行交接`。這張卡只交接單次 Sandbox/Test 喚醒範圍，不會自動喚醒；真正執行時也只能針對同一個 Sandbox/Test issue 與同一位 Hermes Sandbox/Test 員工。完成後授權即結束，必須立刻回到喚醒後檢查面板與 `複製喚醒後覆盤`。

一次性喚醒完成後，請先按 `複製完成停手交接`。這張卡要求立刻停止所有後續 Hermes 動作，回到喚醒後檢查面板，複製 `喚醒後覆盤`，並記錄回覆、員工狀態、live runs 與 recovery issues。覆盤完成前，不建立第二個 issue、不再次喚醒、不 Run now、不啟用排程、不接正式專案。

進入第 4 階前，請先在 Office 按 `複製喚醒前檢查`。這份檢查表要求 Test environment、Hermes Sandbox/Test 員工、Sandbox/Test 專案與使用者確認都通過，並再次提醒 Office 只可預填 issue 草稿。它不代表可以自動建立 issue、不代表可以 Run now、不代表可以啟用 schedule trigger，也不代表可以連續喚醒或接正式專案。

喚醒前檢查填完後，可按 `複製預填判讀`。判讀結果只能是：

- `READY TO PREFILL`：只代表 Office 可以開啟預填 Sandbox/Test issue 草稿；最後建立仍由使用者手動確認。
- `WAIT`：任一條件缺少或尚未確認，只補條件，不建立 issue。
- `PAUSE`：出現 API key、token、密碼、完整 `.env`、正式專案、正式客戶資料、Run now、排程、連續喚醒或 active/running/recovery 風險。

即使是 `READY TO PREFILL`，也不能自動建立 issue、不能 Run now、不能啟用 schedule trigger、不能連續喚醒、不能接正式專案。

若判讀是 `READY TO PREFILL`，先按 `複製第 4 階 READY`。這份交接卡只允許開啟 Office 的預填 Sandbox/Test issue 草稿、檢查標題、描述、專案與負責人，再用 `複製建立前確認`。它仍禁止自動建立 issue、代按建立、Run now、schedule trigger、heartbeat scheduler、連續喚醒、正式資料或喚醒 Hermes。真正喚醒仍需使用者另行貼出一次性喚醒授權。

通過標準：

- Hermes run 成功完成。
- issue 內有 Hermes 留下的可覆盤回覆。
- 沒有產生大量 recovery issues。
- 沒有把員工卡在 running/error。

Office 的 `喚醒後檢查面板` 會協助看四個訊號：

| 訊號 | 判讀 |
| --- | --- |
| Hermes 員工狀態 | 應該沒有 Hermes 員工停在 `running` 或 `error`。 |
| Hermes 舊工作 | 應該沒有 Hermes queued/running live runs。 |
| Recovery issues | 若喚醒後新增 recovery issues，先記錄與覆盤，不要直接進正式任務。 |
| 覆盤紀錄 | 打開 Hermes Sandbox issue，確認回覆可讀、可追溯，且沒有洩漏憑證。 |

真測後請按 `複製喚醒後覆盤`，把回覆是否可讀、員工是否卡住、live runs / recovery 是否乾淨，以及是否可以繼續 Sandbox/Test 整理成固定格式。若出現 running/error、queued/running live runs、recovery issues，或回覆疑似含 API key、token、密碼、完整 `.env`，先停下，不進正式專案。

覆盤回報整理後，請按 `複製覆盤判讀`。判讀只能是 `CLEAN`、`WAIT` 或 `PAUSE`。即使是 `CLEAN`，也只代表這一次 Sandbox/Test 喚醒可記錄為乾淨；仍需先寫進進度與驗收清單，不直接建立下一個 issue、不再次喚醒 Hermes。若要下一個 Hermes 任務，必須重新走 Sandbox/Test 範圍與授權流程。

若覆盤判讀是 `CLEAN`，請按 `複製 CLEAN 記錄`。這份交接卡只用來把乾淨結果寫進今日進度、驗收檢查表與 SOP 實測備註；它不是下一次喚醒授權，也不允許建立第二個 issue、Run now、排程、正式專案或連續喚醒。

若覆盤判讀是 `WAIT` 或 `PAUSE`，請按 `複製 WAIT/PAUSE 處理`。`WAIT` 只允許等待或只讀重新檢查，不建立下一個 issue、不再次喚醒；`PAUSE` 只允許停下、記錄非敏感症狀並覆盤 recovery / running / live run / 憑證風險。兩者都不是下一次喚醒授權。

若未來要開始下一個 Hermes 任務，請按 `複製下一任務入口`。下一個任務必須重新確認 Sandbox/Test 範圍、單一 issue、單一 Hermes Sandbox/Test 員工、無 running/live run/recovery 風險，並重新取得新的明確授權句。上一次 CLEAN 與上一次授權句都不可沿用。

需要對外開源教學或隔天交接時，可按 `複製沙盒循環總結`。這份總結只彙整本次 Sandbox/Test Hermes 任務的範圍、喚醒後訊號、覆盤判讀與下一個安全動作；它不是下一次喚醒授權，也不能替代下一次 Sandbox/Test 檢查與授權。

Office 的 `一次性沙盒喚醒操作紀錄` 可以複製 Markdown 勾選表。建議真測時先貼到文件或測試 issue，再逐項勾選：

```markdown
## Hermes 一次性沙盒喚醒操作紀錄

- [ ] 1. 設定前：確認 Backend OK / Frontend OK，Hermes gate 不再提示缺 model、.env 或 API key。
- [ ] 2. 建立前：確認 Hermes Sandbox/Test 員工與 Sandbox/Test 專案都存在，issue 草稿只掛測試資料。
- [ ] 3. 喚醒前：確認任務內容只要求回覆上下文、skills 與安全邊界，不要求修改檔案或正式資料。
- [ ] 4. 完成後：回到喚醒後檢查面板，確認沒有 running/error、沒有 live run 殘留，並覆盤 issue 回覆。
```

## 第 7 步：開啟更多能力

第一個沙盒喚醒穩定後，再逐步打開：

1. skills 同步。
2. 小型測試任務。
3. 指派到沙盒工作流。
4. 會議或覆盤任務。
5. 最後才考慮自動 heartbeat 或排程。

每次只改一個設定，並把結果補回驗收清單。

## 卡住時

優先順序：

1. 先暫停 Hermes 員工。
2. 跑 `pnpm run office:check` 確認預覽健康。
3. 若需要，跑 `pnpm run office:restart`。
4. 檢查是否還有 queued/running live runs。
5. 只在確認是測試資料時，才取消舊工作或重建沙盒 issue。

`AI-97978` 已完成一次真實 Sandbox/Test 喚醒，因此驗收清單裡的 `Hermes agent 可被喚醒執行` 可標為 `已驗證`。後續若要做第二張沙盒任務，仍必須重新取得明確一次性授權，不能用本次成功結果自動延伸。
## 2026-05-11 AI-98233 authToken-independent runtime prompt proof 喚醒覆盤

- 一次性授權已使用完畢：只對 `AI-98233` 做一次 Hermes Sandbox/Test 喚醒。
- 安全邊界維持：只由 Hermes Sandbox Engineer 回覆該 issue；未 Run now、未啟用 schedule trigger、未打開 heartbeat scheduler、未接正式專案、未處理正式資料、未連續喚醒。
- run：`a102f0c4-9d54-42cc-95ea-bcf3ea87a738`。
- comment：`8d2f9aec-ea8d-45cf-83d4-eaa5dedb329b`。
- 收尾：Hermes Sandbox Engineer 已回到 `paused/manual`；`AI-98233` 已標為 `done`。
- 驗證結果：未通過 exact runtime skill key proof。Hermes 沒有回覆 `Paperclip runtime skills` 段落，也沒有逐字列出 `paperclipai/paperclip/...` 或 `company/...` skill keys。
- 新增安全診斷：Hermes wrapper 現在會在真正交給 Hermes CLI 前寫入不含密鑰的 run log 標記：`[paperclip] Hermes prompt routing: taskId=... taskBody=... runtimeSkills=... movedPromptTemplate=... authToken=... explicitApiKey=...`。
- 下一次若要再測，必須建立新的 Sandbox/Test issue，並取得新的逐字一次性授權。先檢查 run log 是否有上述診斷標記，再判斷要追 Paperclip 執行路徑或 Hermes CLI prompt 層。

## 2026-05-11 AI-98234 prompt routing diagnostic proof 喚醒覆盤

- 一次性授權已使用完畢：只對 `AI-98234` 做一次 Hermes Sandbox/Test prompt routing diagnostic proof 喚醒。
- 安全邊界維持：只由 Hermes Sandbox Engineer 回覆該 issue；未 Run now、未啟用 schedule trigger、未打開 heartbeat scheduler、未接正式專案、未處理正式資料、未連續喚醒。
- 喚醒前檢查通過：Backend health OK、Hermes 為 `paused/manual`、desired skills 7 個存在、prompt markers OK、active run 為空、live runs 為 0。
- run：`19e00a29-33fc-4c67-9d6a-b0fe5cdc419f`。
- session：`20260511_223916_c6f61f`。
- comment：`435a3955-fe9d-47c2-8d04-91d11f00fd4f`。
- 收尾：Hermes Sandbox Engineer 已回到 `paused/manual`；`AI-98234` 已標為 `done`，checkoutRunId 已清空。
- 驗證結果：未通過 prompt routing diagnostic proof。Hermes 沒有回覆 `Paperclip runtime skills` 段落，也沒有 exact runtime skill keys；run log 也沒有 `[paperclip] Hermes prompt routing: ...` 診斷標記。
- 覆盤發現：當時 Windows 上殘留多個 Paperclip 後端行程，且舊後端佔用 3100，導致這次喚醒很可能沒有跑到最新 wrapper。已補強 `scripts/start-virtual-office-preview.ps1`，讓 `office:restart` 遞迴清理舊後端 process tree，並修正 stuck backend 掃描函式輸出。
- 修正後 `office:restart` 與 `office:check` 都顯示 Backend / Frontend OK，heartbeat scheduler false。下一次若要再測，仍必須建立新的 Sandbox/Test issue，並取得新的逐字一次性授權；不能把 `AI-98234` 的授權延伸使用。

## 2026-05-11 AI-98235 post-cleanup prompt routing diagnostic proof issue 準備

- 已建立新的完全測試用 Sandbox/Test issue：`AI-98235`。
- issue id：`12584bcd-de1e-40a0-8d09-ed3232cca484`。
- 標題：`[Sandbox/Test] Hermes post-cleanup prompt routing diagnostic proof - no Run now`。
- 指派：`Hermes Sandbox Engineer`。
- 專案：`Virtual Office Sandbox`。
- 狀態：`backlog`。
- 建立後安全復查：comments 為空、runs 為空、checkoutRunId 為 `null`、executionRunId 為 `null`、activeRun 為 `null`，Hermes 仍為 `paused/manual`。
- 只讀 preflight：`pnpm run office:hermes-preflight` 顯示 `READY FOR NEXT SANDBOX/TEST AUTHORIZATION`；Backend OK，desired skills 7 個 OK，prompt markers OK。
- 此 issue 尚未授權喚醒。下一步若要喚醒，必須由使用者貼出明確點名 `AI-98235` 的逐字一次性授權句；不能因「繼續」或「下一步」直接 checkout/wakeup。

## 2026-05-11 AI-98235 post-cleanup prompt routing diagnostic wake review

- `AI-98235` 的一次性授權已使用完畢；本輪只做 Sandbox/Test 喚醒，沒有 Run now、沒有 schedule trigger、沒有 heartbeat scheduler、沒有接正式專案或正式資料。
- run log 已出現 `[paperclip] Hermes prompt routing: taskId=true taskBody=true runtimeSkills=true movedPromptTemplate=true authToken=false explicitApiKey=false`，代表 Paperclip 後端已把 runtime skills 注入 Hermes 會讀取的 `taskBody`。
- Hermes CLI 在模型回覆前失敗：`/bin/bash: -c: line 476: unexpected EOF while looking for matching ```'`。因此本輪沒有取得 `Paperclip runtime skills` exact key 回覆；runtime skill key proof 仍未完成。
- 自動 recovery 一度建立 `AI-98236` 到 `AI-98522` 的 recovery chain；已全部收尾為 done，`AI-98235` 也已 done、blocker 清空，`Hermes Sandbox Engineer` 已回到 `paused/manual`。
- 已補上 recovery guard：`stranded_issue_recovery` 來源的 recovery issue 不再被視為新的 stranded issue 繼續產生 recovery issue；targeted test `does not create recovery issues for stranded recovery issues` 已通過。

## 2026-05-11 Hermes WSL bridge query-file routing

- 已修正 `scripts/hermes-wsl-bridge.cs` 並重新編譯 `scripts/hermes-wsl.exe`。`chat -q` 的長 prompt 不再直接走 Windows/WSL 命令列，而是先寫入 UTF-8 暫存檔，再由 WSL 內的 `scripts/hermes-wsl-query-helper.py` 讀回並呼叫 Hermes。
- 只讀 smoke test 已通過：`scripts\hermes-wsl.exe --version`、`scripts\hermes-wsl.exe chat --help`、含中文與三個反引號的 `chat -q ... --help` 都可正常回 help。
- 這只是 bridge 修正與只讀驗證；下一次真實模型驗證仍需要新的 Sandbox/Test issue 與新的逐字一次性授權。
# 2026-05-12 Hermes Sandbox/Test note: AI-98523

- `AI-98523` authorization is spent. Treat any further Hermes proof as a new test requiring a new Sandbox/Test issue and a new one-time authorization.
- Preflight must confirm: Backend OK, frontend OK, heartbeat scheduler false, Hermes Sandbox Engineer `paused/manual`, no active run, no recovery chain, and WSL can reach the Ollama bridge `/v1/models` endpoint.
- The AI-98523 run showed prompt routing was correct: runtime skills were injected into `taskBody`; shell quoting was no longer the blocker.
- The run failed at local model connection: `API call failed after 3 retries: Connection error`. Do not count this as exact runtime skill-key proof.
- After any failed Sandbox/Test wake, immediately pause Hermes, close only the test/recovery issues created by that wake, add a review comment, and record whether exact skill keys were actually produced.

## 2026-05-12 Hermes Sandbox/Test note: AI-98526

- `AI-98526` authorization is spent. Treat any further Hermes proof as a new test requiring a new Sandbox/Test issue and a new one-time authorization.
- Hermes completed successfully at the process level, but exact runtime skill-key proof did not pass because the completion omitted the `Paperclip runtime skills` section and exact Paperclip keys.
- Run evidence: `00695265-e78f-4463-9450-53f12508de61`, session `20260512_162220_501f37`, exit code 0, prompt routing `runtimeSkills=true`.
- Cleanup rule was followed: Hermes was paused, `AI-98526` was closed, and checkout/execution run fields were cleared.
- Follow-up fix before the next test: runtime skill prompt is now appended after the moved Hermes agent instructions so the exact-key requirement is the last task-body block.

## 2026-05-12 Hermes Sandbox/Test note: AI-98527

- `AI-98527` authorization is spent. Treat any further Hermes proof as a new test requiring a new Sandbox/Test issue and a new one-time authorization.
- Hermes completed successfully at the process level after the taskBody ordering fix, but exact runtime skill-key proof still did not pass.
- Run evidence: `52361152-f7d7-4acf-b0df-6eff4b933133`, session `20260512_164528_5d5ea7`, exit code 0, prompt routing `runtimeSkills=true`.
- Hermes listed Hermes-side skills (`para-memory-files`, `test-utility-tools`) instead of exact Paperclip keys.
- Next diagnosis should inspect Hermes CLI/context handling before another wake; do not keep creating repeat proof issues until that path is understood.

## 2026-05-12 Hermes Sandbox/Test note: AI-98528

- `AI-98528` authorization is spent. Treat any further Hermes proof as a new test requiring a new Sandbox/Test issue and a new one-time authorization.
- Hermes completed successfully at the process level, but exact runtime skill-key proof still did not pass.
- Run evidence: `4ea3dcd1-fcba-47b4-a8d3-4c44a8e0c77c`, session `20260512_171542_132d55`, exit code 0.
- The new Paperclip diagnostic log appeared and proved injection into the actual run: `taskBodyChars=18479`, `runtimeSkillsAfterAgentInstructions=true`, and all 7 exact runtimeSkillKeys were present.
- Hermes response omitted the required `Paperclip runtime skills` section and exact keys, then posted a generic workflow summary.
- Cleanup rule was followed: Hermes was paused/manual, `AI-98528` was closed as done, checkout/execution run fields were cleared, active run was null, and company live runs were 0.
- Next fix should not be another identical wake. Reword the runtime prompt to avoid collision with Hermes internal skills/tools, add a short mandatory answer contract at the very end of taskBody, then create a new Sandbox/Test issue only after that fix is loaded.

## 2026-05-12 Hermes Sandbox/Test note: AI-98529

- `AI-98529` authorization is spent. Treat any further Hermes proof as a new test requiring a new Sandbox/Test issue and a new one-time authorization.
- Hermes completed successfully at the process level after the wording fix to `Paperclip Runtime Capability Keys`.
- Run evidence: `cab5903b-8d15-421b-b91d-21234fe52e24`, session `20260512_175825_f6e082`, exit code 0.
- Diagnostic log appeared: `taskBodyChars=19804`, `runtimeSkillsAfterAgentInstructions=true`, and all 7 exact runtimeSkillKeys were present.
- Result improved: Hermes referenced `PAPERCLIP_RUNTIME_CAPABILITY_KEYS` and listed exact Paperclip capability keys.
- Full proof still did not pass because Hermes did not include the required `Paperclip runtime capability keys` section and did not mark every key as `used` or `visible but not used`.
- Cleanup rule was followed: Hermes was paused/manual, `AI-98529` was closed as done, checkout/execution run fields were cleared, active run was null, company live runs were 0, and `office:check` was OK.
- Next fix should target strict output-format compliance: use a single-purpose key-table issue, or add a verifier/comment retry when the response sees keys but omits the required table.

## 2026-05-12 Hermes Sandbox/Test note: AI-98530

- `AI-98530` authorization is spent. Treat any further Hermes wake as a new test requiring a new Sandbox/Test issue and a new one-time authorization.
- Hermes completed successfully at the process level after the Paperclip-owned prompt template moved `## Final Required Output Contract` after the workflow.
- Run evidence: `76a100e8-9e24-4acc-add4-515cde557494`, session `20260512_184726_cadfe1`, exit code 0.
- Diagnostic log appeared: `taskBodyChars=19729`, `runtimeSkillsAfterAgentInstructions=true`, all 7 exact `runtimeSkillKeys` were present, and `movedPromptTemplate=true`.
- Runtime capability-key proof passed. Hermes included the required `Paperclip runtime capability keys` section, listed all 7 exact Paperclip keys, and marked each as `used` or `visible but not used`.
- Cleanup rule was followed: Hermes was paused/manual, `AI-98530` was closed as done, checkout/execution run fields were cleared, active run was null, company live runs were 0, and `office:check` was OK.
- This proves Paperclip can inject exact runtime capability keys into the real Hermes model prompt and get them back in a reviewable completion under Sandbox/Test controls. It does not authorize Run now, schedule triggers, heartbeat scheduler, formal project work, production data, or continuous wake.

## 正式 Hermes/local model wake-up preflight

使用者若貼出含 `[ISSUE]` 或 `[AGENT]` 的授權文字，仍視為授權模板，不是有效授權。正式 Hermes/local model wake-up 前，必須先把兩個 placeholder 換成具體 issue 與 agent，並執行只讀 preflight：

```powershell
pnpm run office:hermes-production-preflight -- --issue-id=AI-_____ --agent-id=<agent-id>
```

這個 preflight 只讀檢查，不建立 issue、不修改資料、不 checkout、不 wakeup。它會確認：

- Backend health OK。
- 目標 agent 是 `hermes_local`，且為 `paused/manual`。
- 目標 agent heartbeat 明確關閉。
- 目標 issue 沒有不相符的 assignee、checkoutRunId 或 executionRunId。
- 目標 issue 沒有 active run 與 live runs。
- 目標 agent 的 Paperclip runtime capability keys 已設定，且會出現在 prompt 的 `Paperclip Runtime Capability Keys` 與 `PAPERCLIP_RUNTIME_CAPABILITY_KEYS` 區段。

正式喚醒仍需要使用者貼出新的逐字一次性授權，且必須包含具體 issue 與 agent：

```text
我同意只對 <具體 issue> 做一次正式 Hermes/local model wake-up；
只由 <具體 agent> 回覆該 issue；
允許：讀取 issue 內容、回覆一則 comment；
不允許：Run now、schedule trigger、heartbeat scheduler、連續喚醒、修改正式資料、建立新 issue、讀取密鑰或處理未授權資料；
完成後立刻 paused/manual 並覆盤。
```

若授權文字仍含 `[ISSUE]` 或 `[AGENT]`，不得喚醒；只能請使用者補上具體值或先跑只讀 preflight。
