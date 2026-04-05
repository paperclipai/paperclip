---
title: 创建适配器
summary: 构建自定义适配器的指南
---
构建自定义适配器以将 Paperclip 连接到任何智能体运行时。

<Tip>
如果您使用的是 Claude Code，`create-agent-adapter` 技能可以交互式地指导您完成完整的适配器创建过程。只需要求 Claude 创建一个新适配器，它就会引导您完成每个步骤。
</Tip>

## 包结构

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

## 步骤 1：根元数据

`src/index.ts` 由所有三个消费者导入。保持无依赖性。

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

## 第二步：服务器执行

`src/server/execute.ts`是核心。它接收 `AdapterExecutionContext` 并返回 `AdapterExecutionResult`。

主要职责：

1. 使用安全助手读取配置（`asString`、`asNumber`等）
2. 使用 `buildPaperclipEnv(agent)` 加上上下文变量构建环境
3. 从`runtime.sessionParams`解析会话状态
4. 用`renderTemplate(template, data)`渲染提示
5. 使用 `runChildProcess()` 生成进程或通过 `fetch()` 调用
6. 解析输出的使用情况、成本、会话状态、错误
7. 处理未知会话错误（重试新鲜，设置`clearSession: true`）

## 第三步：环境测试

`src/server/test.ts` 在运行之前验证适配器配置。

返回结构化诊断：

- `error` 无效/无法使用的设置
- `warn` 用于非阻塞问题
- `info` 表示检查成功

## 步骤 4：UI 模块

- `parse-stdout.ts` — 将标准输出行转换为 `TranscriptEntry[]` 以供运行查看器使用
- `build-config.ts` — 将表单值转换为 `adapterConfig` JSON
- `ui/src/adapters/<name>/config-fields.tsx` 中的配置字段 React 组件

## 第五步：CLI 模块

`format-event.ts` — 使用 `picocolors` 漂亮地打印 `paperclipai run --watch` 的标准输出。

## 第 6 步：注册

将适配器添加到所有三个注册表：

1. `server/src/adapters/registry.ts`
2. `ui/src/adapters/registry.ts`
3. `cli/src/adapters/registry.ts`

## 技能注入

使您的智能体运行时可以发现 Paperclip 技能，而无需写入智能体的工作目录：

1. **最好：tmpdir + flag** — 创建tmpdir，符号链接技巧，通过CLI flag传递，之后清理
2. **可接受：全局配置目录** — 到运行时的全局插件目录的符号链接
3. **可接受：env var** — 将技能路径env var指向存储库的`skills/`目录
4. **最后手段：提示注入**——在提示模板中包含技能内容

## 安全

- 将智能体输出视为不可信（防御性解析，从不执行）
- 通过环境变量注入秘密，而不是提示
- 配置网络访问控制（如果运行时支持）
- 始终强制执行超时和宽限期