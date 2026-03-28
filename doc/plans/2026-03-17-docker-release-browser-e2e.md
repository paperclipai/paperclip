# Docker 发布浏览器端到端测试计划

## 背景

目前，针对已发布 Paperclip 包的发布冒烟测试是手动且依赖 shell 脚本的：

```sh
HOST_PORT=3232 DATA_DIR=./data/release-smoke-canary PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
HOST_PORT=3233 DATA_DIR=./data/release-smoke-stable PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

这种方式的价值在于，它与用户实际使用的公开安装路径完全一致：

- Docker
- `npx paperclipai@canary`
- `npx paperclipai@latest`
- 已认证的引导流程

但最关键的发布问题仍然需要人工在浏览器中验证：

- 能否使用冒烟凭据登录？
- 是否进入了引导流程页面？
- 能否完成引导流程？
- 初始 CEO 智能体是否真正被创建并运行？

代码仓库中已有两个相关组件：

- `tests/e2e/onboarding.spec.ts` 负责针对本地源代码树验证引导向导
- `scripts/docker-onboard-smoke.sh` 启动已发布的 Docker 安装并自动引导已认证模式，但仅验证 API/会话层

目前缺失的是一个能将这两条路径衔接起来的确定性浏览器测试。

## 目标

添加一套以 Docker 为后端的发布级浏览器端到端测试，全面验证已发布的 `canary` 和 `latest` 安装：

1. 在 Docker 中启动已发布的包
2. 使用已知冒烟凭据登录
3. 验证用户被正确路由至引导流程页面
4. 在浏览器中完成引导流程
5. 验证首个 CEO 智能体已存在
6. 验证初始 CEO 运行已触发，并达到终态或活跃状态

然后将该测试接入 GitHub Actions，使发布验证不再只是手动操作。

## 一句话建议

将现有 Docker 冒烟脚本改造为机器友好的测试框架，添加专用的 Playwright 发布冒烟规范，驱动已认证的浏览器流程针对已发布的 Docker 安装运行，并在 GitHub Actions 中分别对 `canary` 和 `latest` 执行该测试。

## 现有基础

### 现有本地浏览器覆盖

`tests/e2e/onboarding.spec.ts` 已经验证引导向导能够：

- 创建公司
- 创建 CEO 智能体
- 创建初始问题
- 可选地观察任务进度

这是一个良好的基础，但它不能验证公开 npm 包、Docker 路径、已认证登录流程或发布 dist-tag。

### 现有 Docker 冒烟覆盖

`scripts/docker-onboard-smoke.sh` 已经完成了有价值的设置工作：

- 构建 `Dockerfile.onboard-smoke`
- 在 Docker 内运行 `paperclipai@${PAPERCLIPAI_VERSION}`
- 等待健康检查通过
- 注册或登录冒烟管理员用户
- 在已认证模式下生成并接受引导 CEO 邀请
- 验证 board 会话以及 `/api/companies`

这意味着困难的引导问题已基本解决。主要缺口在于该脚本面向人工操作，从未将控制权移交给浏览器测试。

### 现有 CI 结构

代码仓库已有：

- `.github/workflows/e2e.yml`：用于针对本地源代码手动运行 Playwright
- `.github/workflows/release.yml`：用于在 `master` 上发布 canary 以及手动晋升稳定版

因此，正确的做法是扩展现有的测试/发布体系，而非另起炉灶。

## 产品决策

### 1. 发布冒烟应保持确定性且无需外部 token

第一个版本不应依赖 OpenAI、Anthropic 或外部智能体凭据。

使用确定性适配器的引导流程，该适配器可在标准 GitHub runner 和已发布的 Docker 安装中运行。现有的 `process` 适配器配合一个简单命令是此发布门禁的正确基础路径。

这样可以让该测试聚焦于：

- 发布打包
- 认证/引导
- UI 路由
- 引导流程契约
- 智能体创建
- 心跳调用管道

之后可以为真实模型驱动的智能体添加第二条需要凭据的冒烟通道。

### 2. 冒烟凭据成为明确的测试契约

`scripts/docker-onboard-smoke.sh` 中的当前默认值应被视为稳定的测试固件：

- 邮箱：`smoke-admin@paperclip.local`
- 密码：`paperclip-smoke-password`

除非通过环境变量覆盖，否则浏览器测试应使用这些确切值登录。

### 3. 已发布包的冒烟测试与源代码树端到端测试保持独立

维护两条通道：

- 源代码树端到端测试用于功能开发
- 已发布 Docker 发布冒烟测试用于发布信心保障

两者在引导流程断言上有重叠，但它们防护的是不同类别的故障。

## 方案设计

## 1. 添加 CI 友好的 Docker 冒烟框架

重构 `scripts/docker-onboard-smoke.sh`，使其支持两种运行模式：

- 交互模式
  - 保留当前行为
  - 在前台流式输出日志，等待人工检查
- CI 模式
  - 启动容器
  - 等待健康检查通过并完成已认证引导
  - 输出机器可读的元数据
  - 退出时保留容器运行，供 Playwright 使用

推荐结构：

- 保留 `scripts/docker-onboard-smoke.sh` 作为公开入口点
- 添加 `SMOKE_DETACH=true` 或 `--detach` 模式
- 输出包含以下内容的 JSON 数据块或 `.env` 文件：
  - `SMOKE_BASE_URL`
  - `SMOKE_ADMIN_EMAIL`
  - `SMOKE_ADMIN_PASSWORD`
  - `SMOKE_CONTAINER_NAME`
  - `SMOKE_DATA_DIR`

工作流和 Playwright 测试随后可以使用输出的元数据，而无需解析日志。

### 为何重要

当前脚本始终跟踪日志，然后阻塞在 `wait "$LOG_PID"` 处。这对手动冒烟测试来说很方便，但对 CI 编排而言是错误的形态。

## 2. 添加专用的 Playwright 发布冒烟规范

为已发布的 Docker 安装创建第二个 Playwright 入口点，例如：

- `tests/release-smoke/playwright.config.ts`
- `tests/release-smoke/docker-auth-onboarding.spec.ts`

该测试套件不应使用 Playwright 的 `webServer`，因为应用服务器已在 Docker 内部运行。

### 浏览器测试场景

第一个发布冒烟场景应验证：

1. 打开 `/`
2. 未认证用户被重定向到 `/auth`
3. 使用冒烟凭据登录
4. 已认证用户在无公司时进入引导流程页面
5. 引导向导显示预期的步骤标签
6. 创建公司
7. 使用 `process` 创建首个智能体
8. 创建初始问题
9. 完成引导流程并打开已创建的问题
10. 通过 API 验证：
    - 公司已存在
    - CEO 智能体已存在
    - 问题已存在且分配给 CEO
11. 验证首次心跳运行已触发：
    - 检查问题状态是否从初始状态改变，或
    - 检查 agent/runs API 是否显示 CEO 的运行记录，或
    - 两者都检查

测试应容忍运行快速完成的情况。因此，断言应接受以下状态：

- `queued`
- `running`
- `succeeded`

对于断言运行前问题状态已发生变化的情况，问题进展也应同样处理。

### 为何使用独立规范而非复用 `tests/e2e/onboarding.spec.ts`

本地源代码测试和发布冒烟测试的前提假设不同：

- 服务器生命周期不同
- 认证路径不同
- 部署模式不同
- 使用已发布的 npm 包而非本地工作区代码

强行将两者合并到一个规范中只会让两者都变得更糟。

## 3. 在 GitHub Actions 中添加发布冒烟工作流

添加一个专用于此场景的工作流，最好可复用：

- `.github/workflows/release-smoke.yml`

推荐触发方式：

- `workflow_dispatch`
- `workflow_call`

推荐输入参数：

- `paperclip_version`
  - `canary` 或 `latest`
- `host_port`
  - 可选，默认为 runner 安全端口
- `artifact_name`
  - 可选，用于更清晰的产物上传命名

### 作业概要

1. 检出代码仓库
2. 安装 Node/pnpm
3. 安装 Playwright 浏览器依赖
4. 以分离模式启动 Docker 冒烟框架，使用选定的 dist-tag
5. 针对返回的 base URL 运行发布冒烟 Playwright 测试套件
6. 始终收集诊断信息：
   - Playwright 报告
   - 截图
   - 追踪记录
   - `docker logs`
   - 框架元数据文件
7. 停止并移除容器

### 为何使用可复用工作流

这使我们能够：

- 按需手动运行冒烟测试
- 从 `release.yml` 调用它
- 对 `canary` 和 `latest` 复用同一个作业

## 4. 逐步集成到发布自动化中

### 阶段 A：仅限手动工作流

首先将工作流作为纯手动方式发布，以便在不阻塞发布的情况下稳定框架和测试。

### 阶段 B：在 canary 发布后自动运行

当 `.github/workflows/release.yml` 中的 `publish_canary` 成功后，调用可复用的发布冒烟工作流，参数为：

- `paperclip_version=canary`

这将证明刚发布的公开 canary 确实能正常启动并完成引导流程。

### 阶段 C：在稳定版发布后自动运行

当 `publish_stable` 成功后，以如下参数调用同一工作流：

- `paperclip_version=latest`

这为我们提供了稳定版 dist-tag 健康状况的发布后确认。

### 重要说明

在稳定版发布之前无法测试来自 npm 的 `latest`，因为待测包在 `latest` 标签下尚不存在。因此，`latest` 冒烟是发布后验证，而非发布前门禁。

如果之后需要真正的发布前稳定版门禁，应使用独立的 source-ref 或本地构建的包冒烟作业来实现。

## 5. 将诊断信息提升为一等公民

只有当失败能被快速调试时，这个工作流才真正有价值。

始终捕获：

- Playwright HTML 报告
- 失败时的 Playwright 追踪记录
- 失败时的最终截图
- 完整的 `docker logs` 输出
- 输出的冒烟元数据
- 可选的 `curl /api/health` 快照

否则，测试将变成一个不稳定的黑盒，大家最终会失去对它的信任。

## 实施计划

## 第一阶段：框架重构

涉及文件：

- `scripts/docker-onboard-smoke.sh`
- 可选：`scripts/lib/docker-onboard-smoke.sh` 或类似辅助文件
- `doc/DOCKER.md`
- `doc/RELEASING.md`

任务：

1. 为 Docker 冒烟脚本添加分离/CI 模式。
2. 让脚本输出机器可读的连接元数据。
3. 保留当前的交互式手动模式不变。
4. 为 CI 添加可靠的清理命令。

验收标准：

- 一次脚本调用能够启动已发布的 Docker 应用、自动引导它，并将控制权返回给调用者，同时附带足够的浏览器自动化元数据

## 第二阶段：浏览器发布冒烟测试套件

涉及文件：

- `tests/release-smoke/playwright.config.ts`
- `tests/release-smoke/docker-auth-onboarding.spec.ts`
- 根目录 `package.json`

任务：

1. 为外部服务器测试添加专用的 Playwright 配置。
2. 实现登录 + 引导流程 + CEO 创建流程。
3. 断言 CEO 运行已被创建或完成。
4. 添加根级脚本，例如：
   - `test:release-smoke`

验收标准：

- 测试套件在本地针对以下两种情况均能通过：
  - `PAPERCLIPAI_VERSION=canary`
  - `PAPERCLIPAI_VERSION=latest`

## 第三阶段：GitHub Actions 工作流

涉及文件：

- `.github/workflows/release-smoke.yml`

任务：

1. 添加手动和可复用的工作流入口点。
2. 安装 Chromium 和 runner 依赖项。
3. 以分离模式启动 Docker 冒烟测试。
4. 运行发布冒烟 Playwright 测试套件。
5. 上传诊断产物。

验收标准：

- 维护者可以针对 `canary` 或 `latest` 手动运行工作流

## 第四阶段：发布工作流集成

涉及文件：

- `.github/workflows/release.yml`
- `doc/RELEASING.md`

任务：

1. 在 canary 发布后自动触发发布冒烟测试。
2. 在稳定版发布后自动触发发布冒烟测试。
3. 记录预期行为和失败处理方式。

验收标准：

- canary 发布后自动产生已发布包的浏览器冒烟结果
- 稳定版发布后自动产生 `latest` 浏览器冒烟结果

## 第五阶段：未来扩展——真实模型驱动的智能体验证

不属于第一版实现，但这应该是确定性通道稳定后的下一层。

可能的扩展：

- 第二个 Playwright 项目，以仓库 secrets 为门禁
- 在支持 Docker 的环境中对真实 `claude_local` 或 `codex_local` 适配器进行验证
- 断言 CEO 发布了真实的任务/评论产物
- 稳定版发布需等待凭据通道通过才能放行

在无 token 通道可信赖之前，此部分应保持可选状态。

## 验收标准

当已实现的系统能够证明以下所有内容时，本计划即告完成：

1. 已发布的 `paperclipai@canary` Docker 安装可以在 CI 中由 Playwright 进行冒烟测试。
2. 已发布的 `paperclipai@latest` Docker 安装可以在 CI 中由 Playwright 进行冒烟测试。
3. 测试使用冒烟凭据登录已认证模式。
4. 测试在全新实例中看到引导流程。
5. 测试在浏览器中完成引导流程。
6. 测试验证初始 CEO 智能体已被创建。
7. 测试验证至少一次 CEO 心跳运行已触发。
8. 失败时产生可操作的产物，而不仅仅是一个红色的作业状态。

## 风险与待决策事项

### 1. 快速运行的进程可能在 UI 更新前已完成

这是预期行为。断言应优先通过 API 轮询运行的存在性/状态，而非仅依赖视觉指示器。

### 2. `latest` 冒烟是发布后验证，而非预防性措施

这是测试已发布 dist-tag 本身的真实局限性。它仍然有价值，但不应与发布前门禁混淆。

### 3. 不应将测试过度耦合到引导流程的界面文本上

重要的契约是流程成功、已创建的实体以及运行的创建。尽量少使用可见标签，尽可能优先选用稳定的语义选择器。

### 4. 保持冒烟适配器路径简单无趣

为了发布安全，第一个测试应使用尽可能简单的可运行适配器。这里不是验证每个适配器的地方。

## Recommended First Slice

If we want the fastest path to value, ship this in order:

1. add detached mode to `scripts/docker-onboard-smoke.sh`
2. add one Playwright spec for authenticated login + onboarding + CEO run verification
3. add manual `release-smoke.yml`
4. once stable, wire canary into `release.yml`
5. after that, wire stable `latest` smoke into `release.yml`

That gives release confidence quickly without turning the first version into a large CI redesign.
