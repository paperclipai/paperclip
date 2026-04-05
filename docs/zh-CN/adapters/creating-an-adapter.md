---
title: 创建适配器
summary: 构建自定义适配器指南
---

构建自定义适配器以将 Paperclip 连接到任何智能体运行时。

<Tip>
如果你使用的是 Claude Code，`create-agent-adapter` 技能可以交互地引导你完成整个适配器创建过程。只需要求 Claude 创建一个新的适配器，它就会引导你完成每一步。
</Tip>

## 包装结构

```
packages/adapters/<name>/
  package.json
  tsconfig.json
  src/
    index.ts            # 共享元数据
    server/
      index.ts          # 服务器导出
      execute.ts        # 核心执行逻辑
      parse.ts          # 输出解析
      test.ts           # 环境诊断
    ui/
      index.ts          # UI 导出
      parse-stdout.ts   # 转录解析器
      build-config.ts   # 配置生成器
    cli/
      index.ts          # CLI 导出
      format-event.ts   # 终端格式化器
```

## 第 1 步：根元数据

`src/index.ts` 由所有三个使用者导入。保持其不依赖其他项。

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
```

## 第 2 步：服务器执行

`src/server/execute.ts` 是核心。它接收 `AdapterExecutionContext` 并返回 `AdapterExecutionResult`。

主要职责：

1. 使用安全助手读取配置（`asString`、`asNumber` 等）
2. 使用 `buildPaperclipEnv(agent)` 加上上下文变量构建环境
3. 从 `runtime.sessionParams` 解析会话状态
4. 使用 `renderTemplate(template, data)` 渲染提示
5. 使用 `runChildProcess()` 生成进程或通过 `fetch()` 调用
6. 解析使用情况、成本、会话状态、错误的输出
7. 处理未知的会话错误（重试新会话，设置 `clearSession: true`）

## 第 3 步：环境测试

`src/server/test.ts` 在运行之前验证适配器配置。

返回结构化诊断：

- `error` 对于无效/不可用的设置
- `warn` 对于非阻塞问题
- `info` 对于成功的检查

## 第 4 步：UI 模块

- `parse-stdout.ts` — 将 stdout 行转换为运行查看器的 `TranscriptEntry[]`
- `build-config.ts` — 将表单值转换为 `adapterConfig` JSON
- `ui/src/adapters/<name>/config-fields.tsx` 中的配置字段 React 组件

## 第 5 步：CLI 模块

`format-event.ts` — 使用 `picocolors` 为 `paperclipai run --watch` 格式化打印 stdout。

## 第 6 步：注册

将适配器添加到所有三个注册表：

1. `server/src/adapters/registry.ts`
2. `ui/src/adapters/registry.ts`
3. `cli/src/adapters/registry.ts`

## 技能注入

使 Paperclip 技能对智能体运行时可见，而无需写入智能体的工作目录：

1. **最佳：tmpdir + flag** — 创建 tmpdir，符号链接技能，通过 CLI 标志传递，之后清理
2. **可接受：全局配置目录** — 符号链接到运行时的全局插件目录
3. **可接受：env var** — 将技能路径环境变量指向仓库的 `skills/` 目录
4. **最后手段：提示注入** — 在提示模板中包含技能内容

## 安全性

- 将智能体输出视为不可信（防御性解析，决不执行）
- 通过环境变量而不是提示注入机密
- 如果运行时支持，则配置网络访问控制
- 始终强制超时和宽限期
