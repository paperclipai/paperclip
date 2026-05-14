---
title: 外部适配器
summary: 以插件形式构建、打包与分发适配器，无需修改 Paperclip 源码
---

Paperclip 支持外部适配器插件，可从 npm 包或本地目录安装。外部适配器与内置适配器行为一致——执行智能体、解析输出、渲染运行记录——但位于独立包中，无需改动 Paperclip 源码。

## 内置与外部对比

| | 内置 | 外部 |
|---|---|---|
| 源码位置 | `paperclip-fork/packages/adapters/` 内 | 独立 npm 包或本地目录 |
| 注册 | 三处注册表硬编码 | 启动时由插件系统加载 |
| UI 解析器 | 构建时静态导入 | 通过 API 动态加载（见 [UI 解析器](/适配器/04%20适配器%20UI%20解析器%20adapter-ui-parser)） |
| 分发 | 随 Paperclip 发布 | 发布到 npm 或通过 `file:` 链接 |
| 更新 | 需 Paperclip 发版 | 可独立发版 |

## 快速开始

### 最小包结构

```
my-adapter/
  package.json
  tsconfig.json
  src/
    index.ts            # 共享元数据（类型、标签、模型）
    server/
      index.ts          # createServerAdapter() 工厂
      execute.ts        # 核心执行逻辑
      parse.ts          # 输出解析
      test.ts           # 环境与配置诊断
    ui-parser.ts        # 自包含的 UI 运行记录解析器
```

### package.json

```json
{
  "name": "my-paperclip-adapter",
  "version": "1.0.0",
  "type": "module",
  "license": "MIT",
  "paperclip": {
    "adapterUiParser": "1.0.0"
  },
  "exports": {
    ".": "./dist/index.js",
    "./server": "./dist/server/index.js",
    "./ui-parser": "./dist/ui-parser.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@paperclipai/adapter-utils": "^2026.325.0",
    "picocolors": "^1.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

关键字段：

| 字段 | 用途 |
|-------|---------|
| `exports["."]` | 入口——必须导出 `createServerAdapter` |
| `exports["./ui-parser"]` | 自包含 UI 解析器模块（可选但推荐） |
| `paperclip.adapterUiParser` | UI 解析器契约版本（`"1.0.0"`） |
| `files` | 限制发布内容——通常仅 `dist/` |

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

## 服务端模块

插件加载器从包根调用 `createServerAdapter()`。该函数必须返回 `ServerAdapterModule`。

### src/index.ts

```ts
export const type = "my_adapter";     // snake_case，全局唯一
export const label = "My Agent (local)";

export const models = [
  { id: "model-a", label: "Model A" },
];

export const agentConfigurationDoc = `# my_adapter configuration
Use when: ...
Don't use when: ...
`;

// 插件加载器约定所需
export { createServerAdapter } from "./server/index.js";
```

### src/server/index.ts

```ts
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { type, models, agentConfigurationDoc } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    models,
    agentConfigurationDoc,
  };
}
```

### src/server/execute.ts

核心执行函数：接收 `AdapterExecutionContext`，返回 `AdapterExecutionResult`。

```ts
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";

import {
  runChildProcess,
  buildPaperclipEnv,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const { config, agent, runtime, context, onLog, onMeta } = ctx;

  // 1. 用安全方式读取配置
  const cwd = String(config.cwd ?? "/tmp");
  const command = String(config.command ?? "my-agent");
  const timeoutSec = Number(config.timeoutSec ?? 300);

  // 2. 注入 Paperclip 环境变量
  const env = buildPaperclipEnv(agent);

  // 3. 渲染提示词模板
  const prompt = config.promptTemplate
    ? renderTemplate(String(config.promptTemplate), {
        agentId: agent.id,
        agentName: agent.name,
        companyId: agent.companyId,
        runId: ctx.runId,
        taskId: context.taskId ?? "",
        taskTitle: context.taskTitle ?? "",
      })
    : "Continue your work.";

  // 4. 启动进程
  const result = await runChildProcess(command, {
    args: [prompt],
    cwd,
    env,
    timeout: timeoutSec * 1000,
    graceMs: 10_000,
    onStdout: (chunk) => onLog("stdout", chunk),
    onStderr: (chunk) => onLog("stderr", chunk),
  });

  // 5. 返回结构化结果
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    // 可包含持久化的会话状态
    sessionParams: { /* ... */ },
  };
}
```

#### `@paperclipai/adapter-utils` 提供的辅助函数

| 辅助函数 | 用途 |
|--------|---------|
| `runChildProcess(command, opts)` | 带超时、宽限期与流式回调的子进程 |
| `buildPaperclipEnv(agent)` | 注入 `PAPERCLIP_*` 环境变量 |
| `renderTemplate(template, data)` | 提示词模板中的 `{{variable}}` 替换 |
| `asString(v)`、`asNumber(v)`、`asBoolean(v)` | 安全配置读取 |

### src/server/test.ts

运行前校验配置，返回结构化诊断。

```ts
import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks = [];

  // 示例：检测 CLI 是否安装
  checks.push({
    level: "info",
    message: "My Agent CLI v1.2.0 detected",
    code: "cli_detected",
  });

  // 示例：检查工作目录
  const cwd = String(ctx.config.cwd ?? "");
  if (!cwd.startsWith("/")) {
    checks.push({
      level: "error",
      message: `Working directory must be absolute: "${cwd}"`,
      hint: "Use /home/user/project or /workspace",
      code: "invalid_cwd",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: checks.some(c => c.level === "error") ? "fail" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
```

检查级别：

| 级别 | 含义 | 效果 |
|-------|---------|--------|
| `info` | 信息 | 显示在检测结果中 |
| `warn` | 非阻塞 | 黄色提示 |
| `error` | 阻断执行 | 阻止智能体运行 |

## 安装

### 从 npm

```sh
# 通过 Paperclip UI
# 设置 → 适配器 → 从 npm 安装 → "my-paperclip-adapter"

# 或通过 API
curl -X POST http://localhost:3102/api/adapters \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"packageName": "my-paperclip-adapter"}'
```

### 从本地目录

```sh
curl -X POST http://localhost:3102/api/adapters \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"localPath": "/home/user/my-adapter"}'
```

本地适配器会符号链接到 Paperclip 的适配器目录，修改源码后需重启服务端生效。

### 通过 adapter-plugins.json

开发时可编辑 `~/.paperclip/adapter-plugins.json`：

```json
[
  {
    "packageName": "my-paperclip-adapter",
    "localPath": "/home/user/my-adapter",
    "type": "my_adapter",
    "installedAt": "2026-03-30T12:00:00.000Z"
  }
]
```

## 可选：会话持久化

若运行时支持会话（跨心搏的对话连续性），可实现会话编解码：

```ts
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    return r.sessionId ? { sessionId: String(r.sessionId) } : null;
  },
  serialize(params) {
    return params?.sessionId ? { sessionId: String(params.sessionId) } : null;
  },
  getDisplayId(params) {
    return params?.sessionId ? String(params.sessionId) : null;
  },
};
```

在 `createServerAdapter()` 中纳入：

```ts
return { type, execute, testEnvironment, sessionCodec, /* ... */ };
```

## 可选：技能同步

若运行时支持技能/插件，实现 `listSkills` 与 `syncSkills`：

```ts
return {
  type,
  execute,
  testEnvironment,
  async listSkills(ctx) {
    return {
      adapterType: ctx.adapterType,
      supported: true,
      mode: "ephemeral",
      desiredSkills: [],
      entries: [],
      warnings: [],
    };
  },
  async syncSkills(ctx, desiredSkills) {
    // 将期望技能安装到运行时
    return { /* 与 listSkills 相同形状 */ };
  },
};
```

## 可选：模型探测

若运行时在本地配置文件中有默认模型：

```ts
async function detectModel() {
  // 读取 ~/.my-agent/config.yaml 等
  return {
    model: "anthropic/claude-sonnet-4",
    provider: "anthropic",
    source: "~/.my-agent/config.yaml",
    candidates: ["anthropic/claude-sonnet-4", "openai/gpt-4o"],
  };
}

return { type, execute, testEnvironment, detectModel: () => detectModel() };
```

## 发布

```sh
npm run build
npm publish
```

其他 Paperclip 用户即可在 UI 或 API 中按包名安装。

## 安全

- 将智能体输出视为不可信——防御性解析，切勿对输出 `eval()`
- 通过环境变量注入密钥，不要写进提示词
- 若运行时支持，配置网络访问控制
- 始终强制执行超时与宽限期，避免进程无限运行
- UI 解析器在浏览器沙箱中运行——必须零运行时 import、无副作用

## 后续步骤

- [UI 解析器契约](/适配器/04%20适配器%20UI%20解析器%20adapter-ui-parser) — 自定义运行日志解析，让 UI 正确渲染输出
- [创建适配器](/适配器/02%20创建适配器%20creating-an-adapter) — 适配器内部机制完整梳理
- [智能体如何工作](/guides/agent-developer/01%20智能体如何工作%20how-agents-work) — 理解适配器所服务的心搏生命周期
