# 發佈到 npm

有關如何為 npm 建立 Paperclip 套件的低階參考。

對於維護者發布工作流程，請使用 [doc/RELEASING.md](RELEASING.md)。本文檔僅涉及打包內部結構和產生可發佈工件的腳本。

## 目前版本入口點

使用這些腳本而不是舊的一次性發布命令：

- [`scripts/release-start.sh`](../scripts/release-start.sh) 建立或恢復`release/X.Y.Z`
- [`scripts/release-preflight.sh`](../scripts/release-preflight.sh) 在任何金絲雀或穩定版本之前
- [`scripts/release.sh`](../scripts/release.sh) 用於金絲雀和穩定的 npm 發布
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh) 在回滾期間重新指向 `latest`
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh) 推送穩定分支標籤後

## 為什麼CLI需要特殊包裝

CLI 套件、`paperclipai` 從工作區套件匯入程式碼，例如：

- `@paperclipai/server`
- `@paperclipai/db`
- `@paperclipai/shared`
- `packages/adapters/` 下的轉接器包

這些工作區引用在開發期間使用 `workspace:*`。 npm 無法直接為最終用戶安裝這些引用，因此發布版本必須將 CLI 轉換為可發布的獨立套件。

## `build-npm.sh`

運行：

```bash
./scripts/build-npm.sh
```

該腳本做了六件事：

1. 執行禁止令牌檢查，除非提供 `--skip-checks`
2. 運行`pnpm -r typecheck`
3. 將 CLI 入口點與 esbuild 捆綁到 `cli/dist/index.js` 中
4. 使用 `node --check` 驗證捆綁的入口點
5. 將 `cli/package.json` 重寫為可發佈的 npm 清單，並將開發副本儲存為 `cli/package.dev.json`
6. 將儲存庫 `README.md` 複製到 `cli/README.md` 中以取得 npm 包元數據

發布腳本使用 `build-npm.sh`，以便 npm 使用者安裝真正的套件，而不是未解決的工作區相依性。

## 可發佈的 CLI 佈局

在開發過程中，[`cli/package.json`](../cli/package.json) 包含工作區參考。

在發布準備期間：

- `cli/package.json` 成為具有外部 npm 依賴範圍的可發布清單
- `cli/package.dev.json` 暫存開發清單
- `cli/dist/index.js` 包含捆綁的 CLI 入口點
- `cli/README.md` 被複製到 npm 元資料中

發布完成後，發布腳本將恢復開發清單並刪除臨時 README 副本。

## 套件發現

發布工具會掃描工作區以尋找以下公共包：

- `packages/`
- `server/`
- `cli/`

`ui/` 對於 npm 發布仍然被忽略，因為它是私有的。

這很重要，因為所有公共包都作為一個發布單元一起進行版本控制和發布。

## 金絲雀包裝模型

Canary 以 semver 預發行版發布，例如：

- `1.2.3-canary.0`
- `1.2.3-canary.1`

它們在 npm dist-tag `canary` 下發布。

這意味著：- `npx paperclipai@canary onboard` 可以明確安裝它們
- `npx paperclipai onboard` 繼續解決`latest`
- 穩定的更新日誌可以保留在`releases/v1.2.3.md`

## 穩定的封裝模型

穩定版本發布正常的 semver 版本，例如 npm dist-tag `latest` 下的 `1.2.3`。

穩定的發布流程還在 `release/X.Y.Z` 上建立本地發布提交和 git 標籤。推送該分支提交/標籤、建立 GitHub 版本以及將發布分支合併回 `master` 是隨後作為單獨的維護者步驟發生的。

## 回滾模型

回滾不會取消發布包。

相反，維護者應該將 `latest` dist-tag 移回先前的穩定版本：

```bash
./scripts/rollback-latest.sh <stable-version>
```

這可以保持歷史記錄完整，同時快速恢復預設安裝路徑。

## CI 註釋

此儲存庫包含手動 GitHub Actions 發布工作流程，位於 [`.github/workflows/release.yml`](../.github/workflows/release.yml)。

推薦的 CI 發佈設定：

- 透過 GitHub OIDC 使用 npm 可信任發布
- 需通過`npm-release`環境批准
- 從 `release/X.Y.Z` 運行版本
- 先使用金絲雀，然後使用穩定版

## 相關文件

- [`scripts/build-npm.sh`](../scripts/build-npm.sh)
- [`scripts/generate-npm-package-json.mjs`](../scripts/generate-npm-package-json.mjs)
- [`cli/esbuild.config.mjs`](../cli/esbuild.config.mjs)
- [`doc/RELEASING.md`](RELEASING.md)