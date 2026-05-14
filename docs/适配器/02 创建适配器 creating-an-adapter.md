---
title: 创建适配器
summary: 构建自定义适配器的指南
---

构建自定义适配器，将 Paperclip 接到任意智能体运行时。

<Tip>
若你使用 Claude Code，`.agents/skills/create-agent-adapter` 技能可交互式引导完整适配器创建流程。请让 Claude 创建新适配器，它会逐步带你完成每一步。
</Tip>

## 两条路径

| | 内置 | 外部插件 |
|---|---|---|
| 源码位置 | 在 `paperclip-fork` 仓库内 | 独立 npm 包 |
| 分发方式 | 随 Paperclip 发布 | 独立发布到 npm |
| UI 解析器 | 构建时静态导入 | 通过 API 动态加载 |
| 注册方式 | 编辑 3 处注册表 | 启动时自动加载 |
| 最适合 | 核心适配器、贡献者 | 第三方适配器、内部工具 |

多数情况下，**应构建外部适配器插件**：边界更清晰、可独立发版，且无需改 Paperclip 源码。完整说明见 [外部适配器](/适配器/03%20外部适配器%20external-adapters)。

本页其余部分介绍两条路径共用的内部机制。

## 包结构

```
packages/adapters/<name>/    # 内置
  ── 或 ──
my-adapter/                   # 外部插件
  package.json
  tsconfig.json
  src/
    index.ts            # 共享元数据
    server/
      index.ts          # 服务端导出（createServerAdapter）
      execute.ts        # 核心执行逻辑
      parse.ts          # 输出解析
      test.ts           # 环境与配置诊断
    ui/
      index.ts          # UI 导出（仅内置）
      parse-stdout.ts   # 运行记录解析（仅内置）
      build-config.ts   # 配置构建
    ui-parser.ts        # 自包含 UI 解析器（外部——见 [UI 解析器契约](/适配器/04%20适配器%20UI%20解析器%20adapter-ui-parser)）
    cli/
      index.ts          # CLI 导出
      format-event.ts   # 终端格式化
```

## 步骤 1：根元数据

`src/index.ts` 会被三类消费者导入，尽量保持无外部依赖。

```ts
export const type = "my_agent";        // snake_case，全局唯一
export const label = "My Agent (local)";
export const models = [
  { id: "model-a", label: "Model A" },
];
export const agentConfigurationDoc = `# my_agent configuration
Use when: ...
Don't use when: ...
Core fields: ...
`;

// 外部适配器（插件加载器约定）必需
export { createServerAdapter } from "./server/index.js";
```

## 步骤 2：服务端 execute

`src/server/execute.ts` 是核心：接收 `AdapterExecutionContext`，返回 `AdapterExecutionResult`。

主要职责：

1. 使用安全辅助函数读取配置（`asString`、`asNumber` 等，来自 `@paperclipai/adapter-utils/server-utils`）
2. 用 `buildPaperclipEnv(agent)` 与上下文变量构建环境
3. 从 `runtime.sessionParams` 解析会话状态
4. 用 `renderTemplate(template, data)` 渲染提示词
5. 用 `runChildProcess()` 启动进程或通过 `fetch()` 调用远端
6. 解析输出中的用量、费用、会话状态与错误
7. 处理未知会话类错误（可重试全新会话并设置 `clearSession: true`）

### 可用辅助函数

| 辅助函数 | 来源 | 用途 |
|--------|--------|---------|
| `runChildProcess(cmd, opts)` | `@paperclipai/adapter-utils/server-utils` | 带超时、宽限期与流式回调的子进程 |
| `buildPaperclipEnv(agent)` | `@paperclipai/adapter-utils/server-utils` | 注入 `PAPERCLIP_*` 环境变量 |
| `renderTemplate(tpl, data)` | `@paperclipai/adapter-utils/server-utils` | `{{variable}}` 占位替换 |
| `asString(v)` | `@paperclipai/adapter-utils` | 安全读取字符串配置 |
| `asNumber(v)` | `@paperclipai/adapter-utils` | 安全读取数值 |

### AdapterExecutionContext

```ts
interface AdapterExecutionContext {
  runId: string;
  agent: { id: string; companyId: string; name: string; adapterConfig: unknown };
  runtime: { sessionId: string | null; sessionParams: Record<string, unknown> | null };
  config: Record<string, unknown>;      // 智能体的 adapterConfig
  context: Record<string, unknown>;      // 任务、唤醒原因等
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
}
```

### AdapterExecutionResult

```ts
interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  usage?: { inputTokens: number; outputTokens: number };
  sessionParams?: Record<string, unknown> | null;  // 跨心搏持久化
  sessionDisplayId?: string | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  clearSession?: boolean;  // 下次唤醒强制新会话时设为 true
}
```

## 步骤 3：环境检测

`src/server/test.ts` 在运行前校验适配器配置。

返回结构化诊断：

| 级别 | 含义 | 效果 |
|-------|---------|--------|
| `error` | 配置无效或不可用 | 阻止执行 |
| `warn` | 非阻塞问题 | 黄色提示 |
| `info` | 检查通过 | 显示在检测结果中 |

```ts
export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  return {
    adapterType: ctx.adapterType,
    status: "pass",  // "pass" | "warn" | "fail"
    checks: [
      { level: "info", message: "CLI v1.2.0 detected", code: "cli_detected" },
      { level: "warn", message: "No API key found", hint: "Set ANTHROPIC_API_KEY", code: "no_key" },
    ],
    testedAt: new Date().toISOString(),
  };
}
```

## 步骤 4：UI 模块（仅内置）

对在 Paperclip 源码中注册的内置适配器：

- `parse-stdout.ts` — 将标准输出行转为运行查看器用的 `TranscriptEntry[]`
- `build-config.ts` — 将表单值转为 `adapterConfig` JSON
- 配置字段的 React 组件放在 `ui/src/adapters/<name>/config-fields.tsx`

外部适配器改用自包含的 `ui-parser.ts`，见 [UI 解析器契约](/适配器/04%20适配器%20UI%20解析器%20adapter-ui-parser)。

## 步骤 5：CLI 模块

`format-event.ts` — 使用 `picocolors` 为 `paperclipai run --watch` 美化标准输出。

```ts
export function formatStdoutEvent(line: string, debug: boolean): void {
  if (line.startsWith("[tool-done]")) {
    console.log(chalk.green(`  ✓ ${line}`));
  } else {
    console.log(`  ${line}`);
  }
}
```

## 步骤 6：注册（仅内置）

将适配器加入三处注册表：

1. `server/src/adapters/registry.ts`
2. `ui/src/adapters/registry.ts`
3. `cli/src/adapters/registry.ts`

外部适配器由插件加载器自动注册。

## 会话持久化

若运行时支持跨心搏的对话连续性：

1. 在 `execute()` 中返回 `sessionParams`（例如 `{ sessionId: "abc123" }`）
2. 下次唤醒时读取 `runtime.sessionParams` 以续接
3. 可选：实现 `sessionCodec` 做校验与展示

```ts
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) { /* 校验原始会话数据 */ },
  serialize(params) { /* 序列化以便存储 */ },
  getDisplayId(params) { /* 人类可读的会话标签 */ },
};
```

## 能力标志

适配器可在 `ServerAdapterModule` 上设置可选字段，声明支持的「本地」能力。服务端与 UI 据此为使用该适配器的智能体启用功能（指令包编辑器、技能同步、JWT 鉴权等）。

| 标志 | 类型 | 默认 | 控制内容 |
|------|------|---------|----------------|
| `supportsLocalAgentJwt` | `boolean` | `false` | 心搏是否为智能体生成本地 JWT |
| `supportsInstructionsBundle` | `boolean` | `false` | 托管指令包（AGENTS.md）——服务端解析 + UI 编辑器 |
| `instructionsPathKey` | `string` | `"instructionsFilePath"` | `adapterConfig` 中存放指令文件路径的键名 |
| `requiresMaterializedRuntimeSkills` | `boolean` | `false` | 执行前是否必须把运行时技能条目写入磁盘 |

这些标志会通过 `GET /api/adapters` 的 `capabilities` 对象暴露，并附带派生的 `supportsSkills`（当定义了 `listSkills` 或 `syncSkills` 时为 true）。

### 示例

```ts
export function createServerAdapter(): ServerAdapterModule {
  return {
    type: "my_k8s_adapter",
    execute: myExecute,
    testEnvironment: myTestEnvironment,
    listSkills: myListSkills,
    syncSkills: mySyncSkills,

    // 能力标志
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
  };
}
```

设置后，Paperclip UI 会自动为该适配器的智能体显示指令包编辑器、技能管理页与工作目录等——无需再改 Paperclip 源码。

若未设置能力标志，服务端会对内置类型回退到硬编码列表；外部适配器若省略标志，则各项能力默认为 `false`。

## 技能注入

在不写入智能体工作目录的前提下，让 Paperclip 技能对运行时可见：

1. **优先：临时目录 + 参数** — 创建临时目录、符号链接技能、通过 CLI 标志传入，结束后清理
2. **可接受：全局配置目录** — 链接到运行时的全局插件目录
3. **可接受：环境变量** — 用环境变量指向仓库的 `skills/` 目录
4. **最后手段：提示词注入** — 将技能内容写进提示词模板

## 安全

- 将智能体输出视为不可信（防御性解析，切勿执行）
- 通过环境变量注入密钥，不要写进提示词
- 若运行时支持，配置网络访问控制
- 始终设置超时与宽限期
- UI 解析器在浏览器沙箱中运行——零运行时 import、无副作用

## 后续步骤

- [外部适配器](/适配器/03%20外部适配器%20external-adapters) — 构建独立适配器插件
- [UI 解析器契约](/适配器/04%20适配器%20UI%20解析器%20adapter-ui-parser) — 自定义运行日志解析
- [智能体如何工作](/指南/智能体开发者/01%20智能体如何工作%20how-agents-work) — 心搏生命周期
