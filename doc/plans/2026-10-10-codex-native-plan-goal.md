# Paperclip Codex 原生 Plan 模式：Goal 执行方案

日期：2026-10-10。原始方案：[原始版本](2026-10-10-codex-native-plan-original.md)。

## 1. Goal 目标

实现并验证：普通任务显式保存 `workMode = "planning"`，通过 `paperclip_runner` 原生 Codex provider 执行时，真实 Codex app-server 的每一次 `turn/start` 都收到完整的 `collaborationMode`，其 `mode` 为 `plan`。新建、继续执行、warm 复用和重启恢复遵守相同规则。计划审批后转换为 `standard` 的后续执行使用默认模式。

完成代码、必要测试及文档更新，将执行结果另存 Markdown。原始方案和本方案均保留，不以执行记录覆盖。

## 2. 已确认的根因

生产路径为：

```text
issue.workMode → executionMode → CodexAppServerDriver
  → RunnerdCodexTransport → PRP → Rust CodexProvider → Codex app-server
```

上层已经将 `planning` 映射为 `plan`。当前断点在内部桥接：

- TypeScript `RunnerdCodexTransport` 向 provider 配置发送 `collaborationMode` 和 `includeCollaborationModeInstructions`，但 Rust `CodexProviderConfig` 没有对应字段，反序列化时丢弃。
- transport 的 `collaborationMode/list` 无条件返回 `runner-managed` plan preset；真实 Rust provider 尚未向 app-server 协商。
- transport 的 `turn.start` 没有传递 Codex `effort`；Rust 的真实 `turn/start` 没有 `collaborationMode`。
- Rust 权限选择只有 workspace-only 与 external-sandbox，尚未按规划模式选择已存在的只读 profile。

上层 fake transport 测试通过不足以证明生产路径正确。

## 3. 范围及约束

使用任务现有 work mode、计划文档同步、审批及恢复机制，不新增任务 UI 开关、公共 REST API 或数据库迁移。变更集中在 Runner provider 配置、会话响应及内部 turn 参数。

保持公司隔离、run authority、active-turn、请求去重、恢复证据和预算约束。其他 provider 的现有规划实现保持兼容，尤其 OpenCode/ACPX 不套用 Codex 的协商 API。模式由耐久会话配置决定，不能通过 steer 或任意 per-turn 输入切换。

沿用外部 sandbox 启动策略和已有权限 profile 定义；本改动不扩大文件访问，也不宣称新增操作系统隔离能力。默认任务不因本功能额外依赖 plan API。无需调用付费模型即可完成主要验证。

## 4. 配置及协议设计

### 4.1 Rust provider 配置

在 `runner/crates/runner-core/src/codex_provider.rs` 接收并保存 camelCase 配置：

- `collaborationMode`：仅接受 `default` / `plan`；旧存档缺失字段按 default 处理。兼容序列化时避免无意义地改变旧 default 配置的比较结果。
- `includeCollaborationModeInstructions`：可选 boolean，缺失时保持旧配置兼容；将显式值与 `skills.include_instructions` 合并至 `thread/start`、`thread/resume` 的 `config`。

限制真实模式协商与权限选择仅影响 Codex，避免共享 provider backend 改变其他 provider 行为。

### 4.2 实际协商及模型选择

每次启动新的 Codex provider 进程，包括恢复已有线程，都向真实 app-server 请求 `collaborationMode/list` 并校验 plan preset。利用已有 `experimentalApi` 初始化，不新增无关能力。

保存实际 plan 设置，模型优先使用 `thread/start` / `thread/resume` 返回的有效模型；响应缺少有效模型时，使用明确配置的模型，再考虑 preset 模型。排除 `runner-managed` 等占位值。无法得到有效 preset/model 时，以 `planning_mode_unsupported` 明确失败。

协商错误、缺失 preset、错误响应及旧 daemon 缺少确认都不能被提示词规划或 synthetic preset 掩盖。失败时沿用现有启动清理和错误分类路径。

### 4.3 实际回合

补通 TypeScript `effort` → PRP `turn.start` → Rust `CodexTurnOptions`。验证合法 effort，并保持 OpenCode 的 `reasoningMode` 独立。

plan 回合最终发送：

```json
{
  "collaborationMode": {
    "mode": "plan",
    "settings": {
      "model": "<实际有效模型>",
      "reasoning_effort": "<显式 effort，否则 preset effort，允许 null>",
      "developer_instructions": null
    }
  }
}
```

模式在每次 `turn/start` 由 Rust 根据会话配置构造，不依赖外层传入的 sentinel。默认模式保持现有请求行为；显式 effort 应能到达真实默认回合。`turn/steer` 继承当前回合，不增加模式切换参数。

### 4.4 模式确认回传

Rust `session.open` 和 `session.snapshot` 结果暴露实际协商的 `collaborationMode`；默认会话可以返回 null。TypeScript 解析并验证真实确认，从中生成 Codex plan preset，替换 unconditional `runner-managed` 声明。

覆盖冷启动、thread resume、warm authority rotation、重启后的 session snapshot。旧 daemon 没有模式确认时，默认模式允许继续；请求 plan 时明确失败。共享类型或内部 JSON schema 如受影响，同步更新并运行契约检查。

## 5. 会话兼容和审批转换

- 模式参与耐久 provider 配置兼容性比较；不同模式不能复用不兼容的 warm provider。
- 相同 plan 会话连续回合使用同一确认。重新启动进程后重新协商，不以旧 TypeScript 上下文替代当前进程确认。
- 旧 default 存档可读取；旧 planning 记录缺少实际确认，不得直接认定为原生 plan。使用已有安全恢复/重建边界，禁止改写活动回合或放宽 stop proof。
- 计划获批后，沿用服务端 `planning → standard` 及 executionMode/checkpoint compatibility 隔离；验证后续默认回合没有残留 plan 设置。
- 如新字段导致旧配置 immutable 比较冲突，采用局限于已验证静止会话的兼容处理，或明确失败；不能为迁移恢复而绕过 authority/identity 检查。

## 6. 实施顺序与主要文件

1. 核对本机 Codex app-server schema，确认 mode/settings、preset 返回结构及 effort 值；官方文档不可访问时记录限制，以可生成的本机 schema 和现有源码为依据。
2. 修改 `packages/paperclip-runner/runner/crates/runner-core/src/codex_provider.rs`，实现配置校验、指令 config 合并、真实协商、权限选择、有效模型及 turn 参数。
3. 修改同目录 `provider_backend.rs`，完善 session.open/snapshot 和 turn.start 参数传递，以及必要的旧配置兼容逻辑。
4. 修改 `packages/paperclip-runner/src/live/runnerd-codex-transport.ts`，解析确认并补通 effort；视需要修正 `codex-app-server-driver-impl.ts` 的模型优先级。
5. 扩展 fake app-server、Rust provider/backend 测试及 TypeScript 实进程 transport 集成测试。
6. 更新 Runner 使用文档及执行记录；完成验证后才声明 Goal 完成。

## 7. 测试矩阵

| 场景 | 必须证明 |
| --- | --- |
| 新 planning 任务 | 真正调用 collaborationMode/list，最终 turn/start 含完整 plan 设置 |
| 配置和指令 | collaboration 和 skills 配置合并；plan 使用已有只读 profile |
| 模型及 effort | 有效线程模型优先；显式 effort 优先于 preset，缺省可为 null |
| 连续 plan 回合 | 每次真实 turn/start 均为 plan |
| 恢复已有线程 | thread/resume、新进程重新协商、snapshot 真实回传 |
| warm 复用 | 同模式保留确认，不同模式不能复用不兼容 provider |
| plan 审批转换 | standard 后续回合使用默认模式，无 plan 残留 |
| 能力缺失或协议失败 | planning_mode_unsupported，启动清理，不静默降级 |
| 旧存档/旧 daemon | default 兼容；缺确认的 planning 不假报成功 |
| 其他 provider | OpenCode/ACPX 原有规划契约不回归 |

至少一项集成测试穿过 TypeScript transport、真实 Rust runnerd 和 fake app-server，检查最后一层 JSON，而非只检查 mock 返回值。不得为测试修改生产安全或恢复规则。

## 8. 验证命令与完成条件

先运行相关 Rust provider 测试、Rust 格式/编译检查、TypeScript transport/driver 测试及 Runner 类型/契约检查。按仓库要求执行：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

现有依赖缺失、沙箱限制或基线失败须记录准确命令和原因。必要时使用已安装的工具路径；不提交依赖安装带来的 lockfile 变化。后端改动无需默认启动浏览器或调用真实付费模型。

Goal 完成必须有真实 wire 请求证据、核心回归测试及可检查代码。无法通过的检查如实报告，不能以测试未运行冒充通过。

## 9. 交付及运行指令

保留两份方案，并另存 `doc/plans/2026-10-10-codex-native-plan-execution.md`，记录实现文件、验证结果、未验证限制和交付状态。在当前工作区以本方案创建 Codex goal 并继续实施。无需等待再次确认；不自动发布、部署、提交或推送 PR。

部署采用配套的 TypeScript、Rust runnerd 和远端 Runner 镜像版本。本次交付生成本地可审查变更，外部部署另行执行。若此会话没有绑定 Paperclip issue，不创建或猜测外部 issue；使用用户指定的本地 Markdown 路径交付。
