---
title: 建立適配器
summary: 建立自訂適配器的指南
---
建立自訂適配器以將 Paperclip 連接到任何智能體運行時。

<Tip>
如果您使用的是 Claude Code，`create-agent-adapter` 技能可以互動式地引導您完成完整的適配器建立流程。只需要求 Claude 建立一個新轉接器，它就會引導您完成每個步驟。
</Tip>

## 套件結構

```
packages/adapters/<name>/
  package.json
  tsconfig.json
  src/
    index.ts            # Shared metadata
    server/
      index.ts          # Server exports
      execute.ts        # Core execution logic
      parse.ts          # Output parsing
      test.ts           # Environment diagnostics
    ui/
      index.ts          # UI exports
      parse-stdout.ts   # Transcript parser
      build-config.ts   # Config builder
    cli/
      index.ts          # CLI exports
      format-event.ts   # Terminal formatter
```

## 步驟 1：根元數據

`src/index.ts` 由所有三個消費者導入。保持無依賴性。

```ts
export const type = "my_agent";        // snake_case, globally unique
export const label = "My Agent (local)";
export const models = [
  { id: "model-a", label: "Model A" },
];
export const agentConfigurationDoc = `# my_agent configuration
Use when: ...
Don't use when: ...
Core fields: ...
`;
```

## 第二步：伺服器執行

`src/server/execute.ts`是核心。它接收 `AdapterExecutionContext` 並傳回 `AdapterExecutionResult`。

主要職責：

1. 使用安全助手讀取設定（`asString`、`asNumber`等）
2. 使用 `buildPaperclipEnv(agent)` 加上情境變數建構環境
3. 從`runtime.sessionParams`解析會話狀態
4. 用`renderTemplate(template, data)`渲染提示
5. 使用 `runChildProcess()` 產生進程或透過 `fetch()` 調用
6. 解析輸出的使用情況、成本、會話狀態、錯誤
7. 處理未知會話錯誤（重試新鮮，設定`clearSession: true`）

## 第三步：環境測試

`src/server/test.ts` 在運作之前驗證適配器配置。

返回結構化診斷：

- `error` 無效/無法使用的設置
- `warn` 用於非阻塞問題
- `info` 表示檢查成功

## 步驟 4：UI 模組

- `parse-stdout.ts` — 將標準輸出行轉換為 `TranscriptEntry[]` 以供運行檢視器使用
- `build-config.ts` — 將表單值轉換為 `adapterConfig` JSON
- `ui/src/adapters/<name>/config-fields.tsx` 中的設定欄位 React 元件

## 第五步：CLI 模組

`format-event.ts` — 使用 `picocolors` 漂亮地列印 `paperclipai run --watch` 的標準輸出。

## 第 6 步：註冊

將適配器新增至所有三個註冊表：

1. `server/src/adapters/registry.ts`
2. `ui/src/adapters/registry.ts`
3. `cli/src/adapters/registry.ts`

## 技能注入

讓您的智能體程式運行時可以發現 Paperclip 技能，而無需寫入智能體程式的工作目錄：

1. **最好：tmpdir + flag** — 建立tmpdir，符號連結技巧，透過CLI flag傳遞，之後清理
2. **可接受：全域配置目錄** — 到運行時的全域插件目錄的符號鏈接
3. **可接受：env var** — 將技能路徑env var指向儲存庫的`skills/`目錄
4. **最後手段：提示注入**－在提示範本中包含技能內容

## 安全

- 將智能體輸出視為不可信（防禦性解析，從不執行）
- 透過環境變數注入秘密，而不是提示
- 設定網路存取控制（如果執行時間支援）
- 始終強制執行逾時和寬限期