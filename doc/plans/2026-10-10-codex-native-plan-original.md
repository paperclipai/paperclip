# Paperclip Plan Task 接入 Codex 原生 Plan 模式

保存日期：2026-10-10。此文件保存上一轮最终修改方案；完善后的执行方案单独保存，保留本版本。

## 目标与范围

当任务的 `workMode = "planning"`，且使用 `paperclip_runner` 的原生 Codex provider 时，实际发送给 app-server 的每次 `turn/start` 都携带 `collaborationMode.mode = "plan"`。

沿用现有任务模式选择和计划审批流程。修改集中在 Runner 链路，无需新增 UI 开关、REST API 或数据库迁移。

## 实现方案

1. **补通 Rust 配置。** 在 `packages/paperclip-runner/runner/crates/runner-core/src/codex_provider.rs` 中接收、校验并保存上层已有的 `collaborationMode` 和 `includeCollaborationModeInstructions`。缺省模式为 `default`，仅接受 `default`、`plan`。
2. **真实协商原生模式。** Plan 会话打开或恢复时，由 Rust 请求真实 app-server 的 `collaborationMode/list`，确认存在 plan preset；将 collaboration instructions 配置与现有 skill 配置合并传入 `thread/start`、`thread/resume`。协商失败返回 `planning_mode_unsupported`，不降级为提示词模拟。
3. **构造实际回合请求。** Rust 在每次 `turn/start` 添加完整 `collaborationMode`：`mode = "plan"`，模型使用实际线程模型，明确指定的 reasoning effort 优先，否则使用 preset 值，`developer_instructions = null`。补通现有 effort 参数在内部 `turn.start` 的传递。计划模式按现有规则选择只读 permission profile；外部 sandbox 的启动方式沿用现有实现。`turn/steer` 延续当前回合模式，不新增模式切换参数。
4. **让上层确认真实结果。** 在 `packages/paperclip-runner/runner/crates/runner-core/src/provider_backend.rs` 的 `session.open`、`session.snapshot` 结果中返回实际协商的 `collaborationMode`。在 `packages/paperclip-runner/src/live/runnerd-codex-transport.ts` 中使用该结果生成 Codex 的模式声明，替换当前无条件返回的 `runner-managed` plan preset。同步内部类型、契约和文档。

## 会话与兼容性

- 同模式的继续执行、warm 会话和重启恢复都保留模式，并在新 provider 进程中重新协商。
- 计划获批后，沿用现有 `planning → standard` 转换和会话复用隔离；下一次执行使用默认模式，避免残留 plan 状态。
- 旧存档缺失字段按 `default` 读取；缺少真实模式确认的旧 planning 会话不得作为原生 plan 会话复用。活动回合不进行模式切换。
- `standard`、`ask` 沿用默认行为；其他 provider 保持其现有规划实现。发布时同步 TypeScript、Rust daemon 和远端镜像中的 Runner。

## 验证与验收

- 增加穿过 TypeScript transport、Rust runnerd 到 fake app-server 的集成测试，检查最终 JSON 请求包含完整 plan 参数；不能仅断言上层 mock。
- 覆盖新任务、连续回合、warm 复用、重启恢复，以及计划获批后切回默认执行。
- 覆盖缺失 preset、协商失败、旧存档和旧 daemon 未返回模式确认，验证明确失败且不静默降级。
- 验证模型、reasoning effort、只读配置及计划文档同步；执行相关 Rust/TypeScript 测试，交付前完成仓库规定的 typecheck、测试和构建检查。
