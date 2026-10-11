# Paperclip Codex 原生 Plan 模式：Goal 执行记录

日期：2026-10-10。

- [完善前的原始方案](2026-10-10-codex-native-plan-original.md)
- [完善后的 Goal 执行方案](2026-10-10-codex-native-plan-goal.md)

以上两份文档均保留，本记录单独保存。

## 1. 执行结果

已调用 Codex 会话的 `create_goal`，按照完善后的方案完成本地实现和相关验证。

Paperclip `workMode = "planning"` 任务通过原生 Codex provider 执行时，Rust provider 现在会向 app-server 协商真实 plan preset，并在每次由 Runner 发起的 `turn/start` 中发送完整的 `collaborationMode.mode = "plan"`。默认任务继续使用默认模式。相关 Rust、TypeScript 和真实 runnerd 进程链路测试通过。

全仓 typecheck、测试和构建已尝试，但受到工作区其他包依赖未安装的限制，未通过；因此本记录不声明全仓验证通过或发布就绪。详细限制见第 6 节。

本次使用 `openai-docs` 技能核对本机协议，并按 `create-agent-adapter` 技能检查配置、会话兼容及 provider 边界。官方网页不可访问时，使用本机 Codex 0.162.0 生成的 experimental app-server JSON Schema 作为协议依据。

## 2. 实际修改

| 文件 | 结果 |
| --- | --- |
| [codex_provider.rs](../../packages/paperclip-runner/runner/crates/runner-core/src/codex_provider.rs) | 接收模式和协作指令配置；合并 thread config；真实协商 preset；解析有效模型；每轮构造 plan settings；传递 effort；选择已有只读权限 profile |
| [provider_backend.rs](../../packages/paperclip-runner/runner/crates/runner-core/src/provider_backend.rs) | `session.open` / `session.snapshot` 回传已协商模式；校验并转发 PRP effort；兼容旧 default 配置与缺失的可选指令配置 |
| [runnerd-codex-transport.ts](../../packages/paperclip-runner/src/live/runnerd-codex-transport.ts) | Codex 模式声明改为读取当前 daemon 的 authenticated snapshot；拒绝缺失或无效确认；补通 effort；保留其他 provider 的原有规划契约 |
| [fake-codex-app-server.rs](../../packages/paperclip-runner/runner/crates/runner-core/src/bin/fake-codex-app-server.rs) | 增加真实协商 API 的模拟响应、有效模型及能力缺失场景，用于最终 JSON 请求验证 |
| [Rust 集成测试](../../packages/paperclip-runner/runner/crates/runner-core/tests/codex_provider.rs) | 新增四项 native plan 测试，覆盖协商、连续回合、恢复、warm attach、旧配置、指令配置迁移和失败清理 |
| [TypeScript transport 测试](../../packages/paperclip-runner/src/live/runnerd-codex-transport.test.ts) | 增加最终 wire 参数检查和确认校验；扩展既有 warm 跨 run 测试，覆盖 plan/default 两种模式 |
| [Runner README](../../packages/paperclip-runner/README.md) | 说明原生 plan 行为、错误、会话模式边界及配套升级要求 |

未新增任务 UI、公共 REST API 或数据库迁移。既有 Codex driver 已能使用真实 preset 的有效模型，无需修改其模型选择实现。

## 3. 已验证的最终请求

集成测试实际启动 TypeScript driver、Rust `paperclip-runnerd` 和 fake app-server，并读取 fake app-server 收到的请求日志。以下为已断言的请求字段，不是付费模型调用记录：

```json
{
  "method": "turn/start",
  "params": {
    "effort": "medium",
    "permissions": "paperclip-runner-workspace-read-only",
    "collaborationMode": {
      "mode": "plan",
      "settings": {
        "model": "resolved-model",
        "reasoning_effort": "medium",
        "developer_instructions": null
      }
    }
  }
}
```

这是请求字段的节选，省略了线程 ID、输入等常规字段。测试使用不同的配置模型、preset 模型及线程有效模型，确认最终采用线程有效模型。显式 effort 覆盖 preset effort；没有显式 effort 时保留 preset 值，包括 null。

相同 direct 会话的两次 `turn/start` 均通过上述检查。warm 跨三个 run 的测试确认 runnerd 和 Codex provider PID 不变、真实 app-server 只协商一次，而三个回合均包含完整 plan settings。default 对照组没有协商请求，也没有 `collaborationMode` 字段，显式 effort 仍然被传递。

## 4. 会话与错误行为

- 启动新的 provider 进程，包括 `thread/resume`，都会重新协商；恢复后的 snapshot 使用当前进程确认。
- TypeScript 不再使用 `runner-managed` 占位值声明 Codex 原生 plan 能力。旧 daemon 缺失确认时不能假报原生 plan 成功。
- 缺失 plan preset 或协商 API 返回错误时，明确报 `planning_mode_unsupported`，沿用启动失败清理，未发送任务回合。
- 会话的耐久模式不可通过 warm attach 改变。旧 default 存档与显式 default 配置兼容；已经静止的旧会话可一次性补入原先缺失的指令配置，并重启同一线程。已知配置仍保持不可变。
- `turn/steer` 延续当前回合，未添加模式切换入口；OpenCode 和 ACPX 的规划声明保持各自既有契约。

计划获批后的 `planning → standard` 转换沿用现有服务端逻辑：[issue-thread-interactions.ts](../../server/src/services/issue-thread-interactions.ts)。[native-session-resume.ts](../../server/src/services/native-runtime/native-session-resume.ts) 同时比较 task work mode 和 execution mode，阻止跨模式复用 checkpoint。既有测试 `reuses plan mode across canonical revisions but never across a mode change` 位于 [native-session-resume.test.ts](../../server/src/services/native-runtime/native-session-resume.test.ts)。本次已核对代码，未运行该服务端测试或完整审批用户流程。

## 5. 验证结果

| 检查范围 | 结果 |
| --- | --- |
| Rust Codex provider 完整集成套件 | 96 通过，2 个辅助测试 ignored，0 失败 |
| 更新后的四项 native plan 集成测试 | 4 通过，包含旧指令配置迁移、已知配置不可变和非法 effort 校验 |
| Rust `codex_provider::` 单元测试 | 33 通过 |
| Rust `provider_backend::` 匹配到的后端单元测试 | 86 通过，包含 Codex、ACPX 和 managed provider 回归 |
| 最终 TypeScript transport 定向测试 | 10 通过；其余 211 项未在此次定向命令中运行 |
| Codex driver 与 mock runner 回归 | 23 个文件、339 项测试通过 |
| ACPX Codex driver / runtime adapter 回归 | 2 个文件、191 项测试通过 |
| Node 协议、ACPX sidecar / Codex package 契约 | 34 通过 |
| Runner TypeScript typecheck 与 build:typescript | 通过，包含 ACPX profile 和生成协议契约一致性检查 |
| Rust workspace check、rustfmt check | 通过 |
| `git diff --check` | 通过 |

四项 ACPX 后端测试最初因沙箱禁止绑定本机 TCP 端口失败，获准在沙箱外重跑后通过，不存在尚未解决的该组测试失败。表中不同测试范围有重复覆盖，不应简单相加为独立用例总数。

本次通过 `npx --yes pnpm@9.15.4` 调用 pnpm。关键复现命令如下，工作目录为 `packages/paperclip-runner`：

```sh
npx --yes pnpm@9.15.4 run typecheck:typescript
npx --yes pnpm@9.15.4 run build:typescript
npx --yes pnpm@9.15.4 exec vitest run src/drivers/codex src/mock-core/codex-runner.test.ts
npx --yes pnpm@9.15.4 exec vitest run src/drivers/acpx/codex-acpx-driver.test.ts src/drivers/acpx/codex-runtime-adapter.test.ts
npx --yes pnpm@9.15.4 exec vitest run src/live/runnerd-codex-transport.test.ts -t 'rotates PRP authority in place|sends actual Codex|fails native planning explicitly|requires actual Codex plan confirmation|advertises runner-managed planning|admits Pi runnerd transport'
node --test test/protocol-contract.test.mjs test/acpx-sidecar-contract.test.mjs test/acpx-codex-package-contract.test.mjs
cargo fmt --manifest-path runner/Cargo.toml --all -- --check
cargo check --manifest-path runner/Cargo.toml --locked --workspace
cargo test --manifest-path runner/Cargo.toml --locked -p paperclip-runner-core --test codex_provider
cargo test --manifest-path runner/Cargo.toml --locked -p paperclip-runner-core --test codex_provider native_plan_
cargo test --manifest-path runner/Cargo.toml --locked -p paperclip-runner-core --lib codex_provider::
cargo test --manifest-path runner/Cargo.toml --locked -p paperclip-runner-core --lib provider_backend::
```

本机 Rust 验证使用仓库指定的 1.97.1；为控制磁盘占用，cargo 命令设置 `CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0`。因官方下载缓慢，依赖下载使用命令级 rsproxy sparse mirror，后续测试使用 `--offline`；未修改仓库或全局 Cargo registry 配置，也未修改 lockfile。需要复现本次离线缓存时，在 cargo 命令中加入：

```sh
--config 'source.crates-io.replace-with="paperclip-task-mirror"' \
--config 'source.paperclip-task-mirror.registry="sparse+https://rsproxy.cn/index/"' \
--offline
```

## 6. 未完成的全仓验证与运行限制

在仓库根目录已尝试以下规定检查：

| 命令 | 当前失败原因 |
| --- | --- |
| `npx --yes pnpm@9.15.4 -r typecheck` | 其他 workspace 包没有安装完整依赖，例如缺少 `@types/node` |
| `npx --yes pnpm@9.15.4 test:run` | workspace-link preflight 无法加载 `cli/node_modules/tsx/dist/cli.mjs`，测试套件未进入执行 |
| `npx --yes pnpm@9.15.4 build` | 同一 CLI tsx 依赖缺失，构建未进入执行 |

完整依赖安装曾因 `ENOSPC` 中断。本次仅移除了会话中新建的未完成安装目录，并成功安装 Runner 及其依赖所需的两个 workspace 项目；没有删除用户既有依赖。尚需在磁盘空间足够的环境安装完整 workspace 依赖，再重跑这三项检查及服务端规划审批/恢复测试。

未运行浏览器 E2E、远端 Daytona 镜像测试或真实付费 Codex 模型回合。已证明本地 TypeScript → 真实 Rust runnerd → fake app-server 的最终协议请求；不能据此声称线上部署或完整产品审批流程已经验证。

## 7. 使用与交付

使用配套构建后的 TypeScript transport 与 Rust runnerd，在 Paperclip 任务中选择 Planning，并使用原生 Codex provider，即会进入原生 plan 模式，无需额外手动设置 `collaborationMode`。计划批准后的执行沿用现有 standard 流程。

远端使用时，还需同步 Runner 镜像版本。旧 daemon 缺少实际确认会明确失败，不能仅升级上层 TypeScript。

最初实现阶段的所有源码修改均保留在工作区供审查。原始方案、完善后的方案与本执行记录分别保存；该阶段没有提交、推送、发布、部署或创建 PR。后续发布前需补齐第 6 节的全仓和实际部署验证。

## 8. 本机安装后的网关认证修复（2026-10-11）

本机已安装 `2026.1010.0-local.plan.1`。用户报告一个 Plan Mode 任务运行失败。运行日志确认原生 `plan` 和只读权限已经生效，但模型请求返回 HTTP 401 / `invalid_api_key`，请求地址为 `https://api.openai.com/v1/responses`。

根因是 Runner 创建隔离 `CODEX_HOME` 时保留了本机网关的 `auth.json`，却只识别名为 `paperclip` 的托管 provider，丢弃了用户选择的 `OpenAI` 自定义 provider 和 `base_url`。网关凭据因此被配到了 OpenAI 默认地址。

修复位于 [runtime-context-materializer.ts](../../packages/paperclip-runner/src/drivers/runtime-context-materializer.ts)，回归用例位于 [runtime-context-materializer.test.ts](../../packages/paperclip-runner/src/drivers/runtime-context-materializer.test.ts)。隔离配置现在同时保留所选 provider 的地址和认证方式；`requires_openai_auth = true` 时保留登录缓存，环境变量认证时不复制无关登录缓存。明确配置的本机 HTTP/HTTPS 网关均可使用，托管连接仍要求 HTTPS 或 HTTP loopback。宿主工具、钩子、未选择的 provider 和模型默认值仍不进入隔离配置。无效的所选配置明确失败，不再静默落回默认地址。Runner README 已同步说明。

验证结果：

- 新增 10 项配置/认证回归用例；修改前 9 项失败，修改后通过。
- 5 个相关测试文件首次运行共 352 项通过、1 项 Pi 测试失败。失败来自本机 Node 位于 `/Users/`，触发远程 provider 路径校验；将同一 Node 二进制复制到测试临时目录后，单独重跑该用例通过。合计 353 项完成验证，没有因此修改 Pi 源码或放宽路径校验。
- Runner 的 `tsconfig.json` 编译及 `tsconfig.surfaces.json` 类型检查通过；`git diff --check` 通过。本次窄范围热修复未重跑第 6 节的全仓检查、浏览器 E2E 或完整任务审批流程。
- 使用实际安装的 Codex 0.160.0 和 native runnerd，通过用户现有网关及登录缓存执行隔离验证；模型为原失败运行使用的 `gpt-6-sol`。源码构建和安装后的 Runner 均成功返回所请求的计划，收到 `turn.completed`，确认 `collaborationMode = plan`、`paperclip-runner-workspace-read-only`，且隔离配置保留实际网关地址。

已将 4 个编译产物替换到本机安装中服务端的 `dist/vendor/paperclip-runner/drivers/`，并通过 `paperclipai service restart --json --expected-version 2026.1010.0-local.plan.1` 重启。服务健康，版本仍为 `2026.1010.0-local.plan.1`；热修复名称为 `codex-selected-provider-auth-routing`，文件哈希及备份位置记录在安装目录的 `local-build-provenance.json`。旧产物保存在该安装目录的 `local-hotfix-backups/`。

本次真实验证没有重试原任务、改写历史失败记录或修改用户当前选择的模型。用户可在任务页面点击 Retry，再继续 Plan Mode 对话。此前第 6 节“未运行真实模型回合”的限制只描述最初实现阶段；本节补充的真实网关验证不等同于完整任务审批流程验证。
