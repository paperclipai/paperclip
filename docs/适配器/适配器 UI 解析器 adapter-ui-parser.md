---
title: 适配器 UI 解析器契约
summary: 提供自定义运行日志解析器，使 Paperclip UI 正确渲染适配器输出
---

当 Paperclip 运行智能体时，标准输出会实时流式传到 UI。UI 需要**解析器**把原始 stdout 行转换为结构化运行记录条目（工具调用、工具结果、助手消息、系统事件）。没有自定义解析器时，UI 回退到通用 shell 解析器：几乎所有非系统行都被当作 `assistant` 输出——工具命令会以纯文本泄漏、耗时不可见、错误难以辨认。

## 问题背景

多数智能体 CLI 会输出带工具调用、进度与多行块的结构化 stdout。例如：

```
[hermes] Session resumed: abc123
┊ 💬 Thinking about how to approach this...
┊ $ ls /home/user/project
┊ [done] $ ls /home/user/project — /src /README.md  0.3s
┊ 💬 I see the project structure. Let me read the README.
┊ read /home/user/project/README.md
┊ [done] read — Project Overview: A CLI tool for...  1.2s
The project is a CLI tool. Here's what I found:
- It uses TypeScript
- Tests are in /tests
```

没有解析器时，上述内容整段显示为原始 `assistant` 文本——工具调用与结果和智能体真实回复无法区分。

有解析器时，UI 可以：

- 将 `Thinking about how to approach this...` 渲染为可折叠的思考块
- 将 `$ ls /home/user/project` 渲染为工具调用卡片（可折叠）
- 将 `0.3s` 显示为带耗时的工具结果卡片
- 将 `The project is a CLI tool...` 作为助手回复

## 工作流程

```
┌──────────────────┐     package.json        ┌──────────────────┐
│  Adapter Package  │─── exports["./ui-parser"] ──→│  dist/ui-parser.js │
│  (npm / local)    │                          │  (zero imports)  │
└──────────────────┘                          └────────┬─────────┘
                                                       │ 启动时插件加载器读取
                                                       ▼
┌──────────────────┐   GET /api/:type/ui-parser.js   ┌──────────────────┐
│  Paperclip Server  │◄────────────────────────────────│  uiParserCache    │
│  (memory)          │                                 └──────────────────┘
└────────┬─────────┘
         │ 向浏览器提供 JS
         ▼
┌──────────────────┐   fetch() + eval   ┌──────────────────┐
│  Paperclip UI     │─────────────────────→│  parseStdoutLine │
│  (dynamic loader) │   注册解析器        │  (per-adapter)   │
└──────────────────┘                     └──────────────────┘
```

1. **构建** — 将 `src/ui-parser.ts` 编译为 `dist/ui-parser.js`（零运行时 import）
2. **服务端启动** — 插件加载器读取文件并缓存在内存
3. **UI 加载** — 用户打开某次运行时，UI 从 `GET /api/:type/ui-parser.js` 拉取解析器
4. **运行时** — 获取的模块经 eval 后注册，后续各行使用真实解析器

## 契约：package.json

### 1. `paperclip.adapterUiParser` — 契约版本

```json
{
  "paperclip": {
    "adapterUiParser": "1.0.0"
  }
}
```

Paperclip 宿主会校验该字段。若主版本不兼容，宿主记录警告并回退通用解析器，避免执行可能不兼容的代码。

| 宿主期望 | 适配器声明 | 结果 |
| ------------ | ---------------- | ------------------------------------------------------------- |
| `1.x` | `1.0.0` | 加载解析器 |
| `1.x` | `2.0.0` | 记录警告，使用通用解析器 |
| `1.x` | （缺失） | 加载解析器（宽限期——未来版本可能要求必填） |

### 2. `exports["./ui-parser"]` — 文件路径

```json
{
  "exports": {
    ".": "./dist/server/index.js",
    "./ui-parser": "./dist/ui-parser.js"
  }
}
```

## 契约：模块导出

`dist/ui-parser.js` **至少**导出下列之一：

### `parseStdoutLine(line: string, ts: string): TranscriptEntry[]`

无状态解析器，对适配器 stdout 的每一行调用。

```ts
export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (line.startsWith("[my-agent]")) {
    return [{ kind: "system", ts, text: line }];
  }
  return [{ kind: "assistant", ts, text: line }];
}
```

### `createStdoutParser(): { parseLine(line, ts): TranscriptEntry[]; reset(): void }`

有状态解析器工厂。若需跨行续接、嵌套命令等跨调用状态，优先使用此形式。

```ts
let counter = 0;

export function createStdoutParser() {
  let suppressContinuation = false;

  function parseLine(line: string, ts: string): TranscriptEntry[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    if (suppressContinuation) {
      if (/^[\d.]+s$/.test(trimmed)) {
        suppressContinuation = false;
        return [];
      }
      return []; // 吞掉续行
    }

    if (trimmed.startsWith("[tool-done]")) {
      const id = `tool-${++counter}`;
      suppressContinuation = true;
      return [
        { kind: "tool_call", ts, name: "shell", input: {}, toolUseId: id },
        { kind: "tool_result", ts, toolUseId: id, content: trimmed, isError: false },
      ];
    }

    return [{ kind: "assistant", ts, text: trimmed }];
  }

  function reset() {
    suppressContinuation = false;
  }

  return { parseLine, reset };
}
```

若两者都导出，`createStdoutParser` 优先。

## 契约：TranscriptEntry

每条记录须符合下列可辨识联合形状之一：

```ts
// 助手消息
{ kind: "assistant"; ts: string; text: string; delta?: boolean }

// 思考 / 推理
{ kind: "thinking"; ts: string; text: string; delta?: boolean }

// 用户消息（少见——通常来自智能体发起的提示）
{ kind: "user"; ts: string; text: string }

// 工具调用
{ kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId?: string }

// 工具结果
{ kind: "tool_result"; ts: string; toolUseId: string; content: string; isError: boolean }

// 系统 / 适配器消息
{ kind: "system"; ts: string; text: string }

// 标准错误
{ kind: "stderr"; ts: string; text: string }

// 原始 stdout（回退）
{ kind: "stdout"; ts: string; text: string }
```

### 关联工具调用与结果

使用 `toolUseId` 配对 `tool_call` 与 `tool_result`，UI 将它们渲染为可折叠卡片。

```ts
const id = `my-tool-${++counter}`;
return [
  { kind: "tool_call", ts, name: "read", input: { path: "/src/main.ts" }, toolUseId: id },
  { kind: "tool_result", ts, toolUseId: id, content: "const main = () => {...}", isError: false },
];
```

### 错误展示

工具结果设置 `isError: true` 可显示红色提示：

```ts
{ kind: "tool_result", ts, toolUseId: id, content: "ENOENT: no such file", isError: true }
```

## 约束

1. **零运行时 import。** 文件通过浏览器中 `URL.createObjectURL` + 动态 `import()` 加载。禁止 `import`、`require`、顶层 `await`。
2. **无 DOM / Node API。** 在浏览器沙箱运行，仅用 vanilla JS（ES2020+）。
3. **无副作用。** 模块级代码不得修改全局、访问 `window` 或做 I/O，仅声明并导出函数。
4. **确定性。** 相同 `(line, ts)` 输入必须产生相同输出，这对日志回放很重要。
5. **容错。** 切勿抛异常；无法解析的行应返回 `[{ kind: "stdout", ts, text: line }]`，而非崩溃运行记录管线。
6. **体积。** 建议小于 50 KB（按请求下发并在浏览器 eval）。

## 生命周期

| 事件 | 行为 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 服务端启动 | 插件加载器读取 `exports["./ui-parser"]`，读入文件并缓存在内存 |
| UI 打开运行 | 调用 `getUIAdapter(type)`；若无内置解析器，异步 `fetch(/api/:type/ui-parser.js)` |
| 首批行到达 | 立即由通用进程解析器处理（不阻塞）；动态解析器后台加载 |
| 解析器加载完成 | 调用 `registerUIAdapter()`，此后各行使用真实解析器 |
| 加载失败（404、eval 错误） | 控制台警告；继续使用通用解析器；该类型记入失败缓存，不重试 |
| 服务端重启 | 内存缓存从适配器包重新填充 |

## 错误行为

| 失败情形 | 行为 |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| 模块语法错误（import 失败） | 捕获并记录，回退通用解析器，不重试 |
| 返回形状错误 | 缺字段的单条记录在构建运行记录时被静默忽略 |
| 运行时抛错 | 按行捕获，该行回退通用解析器；解析器仍保留供后续行使用 |
| 404（未导出 ui-parser） | 类型加入失败加载集合，自首次调用起一直使用通用解析器 |
| 契约版本不匹配 | 服务端记录警告并跳过加载，使用通用解析器 |

## 构建

```sh
# TypeScript → JavaScript
tsc src/ui-parser.ts --outDir dist --target ES2020 --module ES2020 --declaration false
```

也可由 `tsconfig.json` 统一处理——确保 `ui-parser.ts` 参与构建并输出到 `dist/ui-parser.js`。

## 测试

本地用示例 stdout 自测：

```ts
// test-parser.ts
import { createStdoutParser } from "./dist/ui-parser.js";

const parser = createStdoutParser();
const sampleLines = [
  "[my-agent] Starting session abc123",
  "Thinking about the task...",
  "$ ls /home/user/project",
  "[done] $ ls — /src /README.md  0.3s",
  "I'll read the README now.",
  "Error: file not found",
];

for (const line of sampleLines) {
  const entries = parser.parseLine(line, new Date().toISOString());
  for (const entry of entries) {
    console.log(`  ${entry.kind}:`, entry.text ?? entry.name ?? entry.content);
  }
}
```

运行：`npx tsx test-parser.ts`

## 不使用 UI 解析器

若适配器 stdout 很简单（无工具标记、无特殊格式），可完全省略 UI 解析器。通用 `process` 解析器会将非系统行视为 `assistant` 输出，适用于：

- 仅输出纯文本的智能体
- 只打印结果的自定义脚本
- 无结构化输出的简单 CLI

做法：不要在 `package.json` 中包含 `exports["./ui-parser"]`。

## 后续步骤

- [外部适配器](/适配器/外部适配器%20external-adapters) — 适配器包完整指南
- [创建适配器](/适配器/创建适配器%20creating-an-adapter) — 适配器内部与内置集成
