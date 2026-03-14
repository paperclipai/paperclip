# 釋放Paperclip

維護者操作手冊，用於跨 npm、GitHub 和麵向網站的變更日誌表面發布完整的 Paperclip 版本。

發布模型是分支驅動的：

1. 在`release/X.Y.Z`上啟動發布列車
2. 起草該分支上的穩定變更日誌
3. 從該分支發布一個或多個金絲雀
4. 從同一個分支頭發布穩定版
5. 推送分支提交和標籤
6. 建立 GitHub 版本
7. 將 `release/X.Y.Z` 合併回 `master`，無需壓縮或變基

## 釋放表面

每個版本都有四個獨立的表面：

1. **驗證** — 確切的 git SHA 透過型別檢查、測試和構建
2. **npm** — `paperclipai` 和公共工作區包發布
3. **GitHub** — 穩定版獲得 git 標籤和 GitHub 版本
4. **網站/公告** — 穩定變更日誌對外發布並公佈

僅當所有四個表面都被處理時才進行釋放。

## 核心不變量

- `X.Y.Z` 的金絲雀和穩定版必須來自同一個 `release/X.Y.Z` 分支。
- 發布腳本必須從匹配的 `release/X.Y.Z` 分支運行。
- 一旦 `vX.Y.Z` 存在於本地、GitHub 或 npm 上，該發布列車就會被凍結。
- 請勿將發布分支 PR 壓縮合併或變基合併回 `master`。
- 穩定的變更日誌始終為 `releases/vX.Y.Z.md`。切勿建立金絲雀變更日誌檔。

合併規則的原因很簡單：標籤必須始終指向確切的已發布提交。擠壓或變基會破壞該屬性。

## 長篇大論；博士

### 1. 啟動發布序列

使用它來計算下一個版本，建立或還原分支，建立或還原專用工作樹，並將分支推送到 GitHub。

```bash
./scripts/release-start.sh patch
```

該腳本：

- 取得發布遙控器和標籤
- 根據最新的 `v*` 標籤計算下一個穩定版本
- 建立或恢復`release/X.Y.Z`
- 建立或還原專用工作樹
- 預設將分支推送到遠端
- 拒絕重複使用冷凍釋放列車

### 2. 起草穩定變更日誌

從發布工作樹：

```bash
VERSION=X.Y.Z
claude --print --output-format stream-json --verbose --dangerously-skip-permissions --model claude-opus-4-6 "Use the release-changelog skill to draft or update releases/v${VERSION}.md for Paperclip. Read doc/RELEASING.md and skills/release-changelog/SKILL.md, then generate the stable changelog for v${VERSION} from commits since the last stable tag. Do not create a canary changelog."
```

### 3.驗證並發布金絲雀

```bash
./scripts/release-preflight.sh canary patch
./scripts/release.sh patch --canary --dry-run
./scripts/release.sh patch --canary
PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
```

用戶安裝金絲雀：

```bash
npx paperclipai@canary onboard
```

### 4. 發布穩定版

```bash
./scripts/release-preflight.sh stable patch
./scripts/release.sh patch --dry-run
./scripts/release.sh patch
git push public-gh HEAD --follow-tags
./scripts/create-github-release.sh X.Y.Z
```

然後開啟一個從 `release/X.Y.Z` 到 `master` 的 PR，並在不壓縮或變基的情況下合併。

## 發布分支

Paperclip 每個目標穩定版本使用一個發布分支：

- `release/0.3.0`
- `release/0.3.1`
- `release/1.0.0`

不要創建單獨的每個金絲雀分支，例如 `canary/0.3.0-1`。金絲雀只是同一間穩定列車的預發布快照。

## 腳本入口點- [`scripts/release-start.sh`](../scripts/release-start.sh) — 建立或恢復發布列車分支/工作樹
- [`scripts/release-preflight.sh`](../scripts/release-preflight.sh) — 驗證分支、版本計劃、git/npm 狀態和驗證閘
- [`scripts/release.sh`](../scripts/release.sh) — 從發布分支發布金絲雀或穩定版
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh) — 推播標籤後建立或更新 GitHub 版本
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh) — 將 `latest` 重新指向最後一個良好的穩定版本

## 詳細工作流程

### 1. 啟動或復原發布序列

運行：

```bash
./scripts/release-start.sh <patch|minor|major>
```

有用的選項：

```bash
./scripts/release-start.sh patch --dry-run
./scripts/release-start.sh minor --worktree-dir ../paperclip-release-0.4.0
./scripts/release-start.sh patch --no-push
```

該腳本故意是冪等的：

- 如果 `release/X.Y.Z` 本地已存在，則重複使用它
- 如果遠端分支已存在，則會在本地恢復它
- 如果分支已經在另一個工作樹中簽出，它會將您指向那裡
- 如果 `vX.Y.Z` 已存在於本地、遠端或 npm 上，則它拒絕重複使用該列車

### 2. 儘早寫出穩定的變更日誌

建立或更新：

- `releases/vX.Y.Z.md`

該文件用於最終的穩定版本。檔案名稱或標題中不應包含 `-canary`。

推薦結構：

- `Breaking Changes` 需要時
- `Highlights`
- `Improvements`
- `Fixes`
- `Upgrade Guide` 需要時
- `Contributors` — 透過 GitHub 使用者名稱@提及每位貢獻者（無電子郵件）

包級 `CHANGELOG.md` 檔案是作為發布機制的一部分產生的。它們不是主要的發布敘述。

### 3. 運行發布預檢

從 `release/X.Y.Z` 工作樹：

```bash
./scripts/release-preflight.sh canary <patch|minor|major>
# or
./scripts/release-preflight.sh stable <patch|minor|major>
```

現在，預檢腳本在執行驗證門之前會檢查以下所有內容：

- 工作樹是乾淨的，包括未追蹤的文件
- 目前分支與計算出的 `release/X.Y.Z` 匹配
- 釋放列車未凍結
- 目標版本在 npm 上仍然免費
- 目標標籤在本地或遠端尚不存在
- 遠端發布分支是否已經存在
- `releases/vX.Y.Z.md`是否存在

然後它運行：

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

### 4. 發布一個或多個金絲雀

運行：

```bash
./scripts/release.sh <patch|minor|major> --canary --dry-run
./scripts/release.sh <patch|minor|major> --canary
```

結果：

- npm 在 dist-tag `canary` 下獲得預發布，例如 `1.2.3-canary.0`
- `latest` 不變
- 沒有建立 git 標籤
- 未建立 GitHub 版本
- 腳本完成後工作樹恢復乾淨

護欄：

- 腳本拒絕從錯誤的分支執行
- 劇本拒絕在結冰的火車上發布
- 金絲雀始終源自於下一個穩定版本
- 如果穩定的註釋檔案遺失，腳本會在您忘記之前發出警告

具體例子：

- 如果最新的穩定版本是 `0.2.7`，則金絲雀補丁的目標是 `0.2.8-canary.0`
- `0.2.7-canary.N` 無效，因為 `0.2.7` 已經穩定

### 5. 對金絲雀進行煙霧測試

運行Docker中的實際安裝路徑：

```bash
PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
```有用的孤立變體：

```bash
HOST_PORT=3232 DATA_DIR=./data/release-smoke-canary PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
HOST_PORT=3233 DATA_DIR=./data/release-smoke-stable PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

如果您想從目前提交的參考而不是 npm 進行入職操作，請使用：

```bash
./scripts/clean-onboard-ref.sh
PAPERCLIP_PORT=3234 ./scripts/clean-onboard-ref.sh
./scripts/clean-onboard-ref.sh HEAD
```

最低限度檢查：

- `npx paperclipai@canary onboard` 安裝
- 引導完成且沒有崩潰
- 伺服器啟動
- 使用者介面載入
- 基本的公司創建和控制台加載工作

如果冒煙測試失敗：

1. 停止穩定版本
2. 修復同一`release/X.Y.Z`分支上的問題
3. 發布另一個金絲雀
4. 重新運行冒煙測試

### 6. 從同一發布分支發布穩定版

分支負責人經過審查後，運行：

```bash
./scripts/release.sh <patch|minor|major> --dry-run
./scripts/release.sh <patch|minor|major>
```

穩定發布：

- 在 `latest` 下將 `X.Y.Z` 發佈到 npm
- 建立本地發布提交
- 建立本機標籤 `vX.Y.Z`

在以下情況下，穩定發布將拒絕繼續：

- 目前分支不是 `release/X.Y.Z`
- 遠端發布分支尚不存在
- 穩定的註釋文件遺失
- 目標標籤已存在於本機或遠端
- npm 上已經存在穩定版本

這些檢查會在穩定發布後故意凍結列車。

### 7. 推送穩定分支提交和標籤

穩定發布成功後：

```bash
git push public-gh HEAD --follow-tags
./scripts/create-github-release.sh X.Y.Z
```

GitHub 發行說明來自：

- `releases/vX.Y.Z.md`

### 8.將release分支合併回`master`

打開 PR：

- 底座：`master`
- 頭：`release/X.Y.Z`

合併規則：

- 允許：合併提交或快轉
- 禁止：擠壓合併
- 禁止：變基合併

合併後驗證：

```bash
git fetch public-gh --tags
git merge-base --is-ancestor "vX.Y.Z" "public-gh/master"
```

該命令必須成功。如果失敗，則無法從 `master` 到達已發布的標記提交，這表示合併策略錯誤。

### 9. 完成外表面

GitHub正確後：

- 在網站上發布變更日誌
- 撰寫並發送公告副本
- 確保公共文件和安裝指南指向穩定版本

## GitHub 行動發布

[`.github/workflows/release.yml`](../.github/workflows/release.yml) 上也有手動工作流程。

從相關 `release/X.Y.Z` 分支的「操作」標籤中使用它：

1. 選擇`Release`
2. 選擇`channel`：`canary`或`stable`
3. 選擇`bump`：`patch`、`minor` 或`major`
4. 選擇是否為`dry_run`
5. 從release分支運行，而不是從`master`運行

工作流程：

- 重新運行 `typecheck`、`test:run` 和 `build`
- 蓋茲在 `npm-release` 環境後面發布
- 可以在不接觸`latest`的情況下發布金絲雀
- 可以發布穩定版，推送穩定版分支提交和標籤，並建立 GitHub 版本

它不會為您將發布分支合併回 `master`。

## 發布清單

### 在任何發布之前- [ ] 發布列車存在於 `release/X.Y.Z`
- [ ] 工作樹是乾淨的，包括未追蹤的文件
- [ ] 如果套件清單發生更改，則 CI 擁有的 `pnpm-lock.yaml` 刷新已在火車被切斷之前合併到 `master` 上
- [ ] 所需的驗證門已通過您要發布的確切分支頭
- [ ] 凹凸類型對於使用者可見的影響是正確的
- [ ] 穩定的變更日誌檔案存在或已準備好，位於 `releases/vX.Y.Z.md`
- [ ] 你知道如果需要的話你會回滾到哪個以前的穩定版本

### 在穩定之前

- [ ] 候選人已通過冒煙測試
- [ ] 遠程`release/X.Y.Z`分支存在
- [ ] 你準備好在npm發布後立即推送穩定分支提交和標記
- [ ] 推播後即可立即建立 GitHub Release
- [ ] 您已準備好開啟PR回`master`

### 穩定後

- [ ] `npm view paperclipai@latest version` 匹配新穩定版本
- [ ] GitHub 上存在 git 標籤
- [ ] GitHub 版本存在並使用 `releases/vX.Y.Z.md`
- [ ] `vX.Y.Z` 可從 `master` 訪問
- [ ] 網站變更日誌已更新
- [ ] 公告副本符合穩定版本，而不是金絲雀版本

## 失敗手冊

### 如果金絲雀發布但冒煙測試失敗

不要發布穩定版。

相反：

1. 修復`release/X.Y.Z`的問題
2. 發布另一個金絲雀
3. 重新運行冒煙測試

### 如果穩定的 npm 發布成功，但推送或 GitHub 版本建立失敗

這是部分版本。 npm 已經上線。

立即執行此操作：

1. 修復同一結帳中的git或GitHub問題
2. 推送穩定分支提交和標籤
3. 創建GitHub版本

請勿重新發布相同版本。

### 如果`latest`在穩定發布後被破壞

預覽：

```bash
./scripts/rollback-latest.sh X.Y.Z --dry-run
```

回滾：

```bash
./scripts/rollback-latest.sh X.Y.Z
```

這不會取消發布任何內容。它只會將 `latest` dist-tag 移回最後一個良好的穩定版本。

然後透過新的補丁版本進行修復。

### 若 GitHub 發行說明有誤

重新運行：

```bash
./scripts/create-github-release.sh X.Y.Z
```

如果版本已存在，腳本將更新它。

## 相關文檔

- [doc/PUBLISHING.md](PUBLISHING.md) — 低階 npm 建構與包裝內部結構
- [技能/發布/SKILL.md](../skills/release/SKILL.md) — 智能體發布協調工作流程
- [skills/release-changelog/SKILL.md](../skills/release-changelog/SKILL.md) — 穩定的變更日誌起草工作流程