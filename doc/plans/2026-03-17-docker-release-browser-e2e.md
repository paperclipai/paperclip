# Docker 发布浏览器端到端测试计划

## 背景

目前针对已发布 Paperclip 包的发布冒烟测试是手动和基于 shell 的：

```sh
HOST_PORT=3232 DATA_DIR=./data/release-smoke-canary PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
HOST_PORT=3233 DATA_DIR=./data/release-smoke-stable PAPERCLIPAI_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

这很有用，因为它执行了用户会接触的相同公开安装流程：

- Docker
- `npx paperclipai@canary`
- `npx paperclipai@latest`
- 认证引导流程

但它仍然将最重要的发布问题留给了拿着浏览器的人：

- 我能用冒烟凭证登录吗？
- 我是否进入了引导流程？
- 我能完成引导流程吗？
- 初始 CEO 智能体是否真的被创建并运行了？

仓库已经有两个相邻的部分：

- `tests/e2e/onboarding.spec.ts` 针对本地源码树覆盖了引导向导
- `scripts/docker-onboard-smoke.sh` 启动已发布的 Docker 安装并自动引导认证模式，但只验证 API/会话层

缺少的是一个确定性的浏览器测试来连接这两条路径。

## 目标

添加一个发布级别的 Docker 支持的浏览器端到端测试，端到端验证已发布的 `canary` 和 `latest` 安装：

1. 在 Docker 中启动已发布的包
2. 用已知的冒烟凭证登录
3. 验证用户被路由到引导流程
4. 在浏览器中完成引导流程
5. 验证第一个 CEO 智能体存在
6. 验证初始 CEO 运行被触发并达到终态或活跃状态

然后将该测试接入 GitHub Actions，使发布验证不再仅依赖手动。

## 一句话建议

将当前的 Docker 冒烟脚本转变为机器友好的测试工具，添加一个专用的 Playwright 发布冒烟规格来驱动针对已发布 Docker 安装的认证浏览器流程，并在 GitHub Actions 中为 `canary` 和 `latest` 运行它。

## 今天已有的

### 现有的本地浏览器覆盖

`tests/e2e/onboarding.spec.ts` 已经证明引导向导可以：

- 创建公司
- 创建 CEO 智能体
- 创建初始任务
- 可选地观察任务进度

这是一个好的基础，但它不验证公开的 npm 包、Docker 路径、认证登录流程或发布 dist-tag。

### 现有的 Docker 冒烟覆盖

`scripts/docker-onboard-smoke.sh` 已经做了有用的设置工作：

- 构建 `Dockerfile.onboard-smoke`
- 在 Docker 内运行 `paperclipai@${PAPERCLIPAI_VERSION}`
- 等待健康检查
- 注册或登录一个冒烟管理员用户
- 在认证模式下生成并接受引导 CEO 邀请
- 验证看板会话和 `/api/companies`

这意味着困难的引导问题大部分已经解决。主要缺口是脚本面向人工操作，从未将控制权交给浏览器测试。

### 现有的 CI 形态

仓库已经有：

- `.github/workflows/e2e.yml` 用于针对本地源码的手动 Playwright 运行
- `.github/workflows/release.yml` 用于 `master` 上的 canary 发布和手动稳定版升级

所以正确的做法是扩展当前的测试/发布系统，而不是创建一个并行系统。

## 产品决策

### 1. 发布冒烟应保持确定性且不需要 token

第一个版本不应需要 OpenAI、Anthropic 或外部智能体凭证。

使用引导流程配合确定性适配器，该适配器可以在标准 GitHub runner 和已发布的 Docker 安装内运行。现有的 `process` 适配器配合简单命令是此发布门禁的正确基础路径。

这使测试专注于：

- 发布打包
- 认证/引导
- UI 路由
- 引导契约
- 智能体创建
- 心跳调用管道

后续我们可以为真实模型支持的智能体添加第二条带凭证的冒烟通道。

### 2. 冒烟凭证成为显式测试契约

`scripts/docker-onboard-smoke.sh` 中的当前默认值应视为稳定的测试固件：

- email: `smoke-admin@paperclip.local`
- password: `paperclip-smoke-password`

浏览器测试应使用这些确切值登录，除非被环境变量覆盖。

### 3. 已发布包冒烟和源码树端到端测试保持分离

保持两条通道：

- 源码树端到端测试用于功能开发
- 已发布的 Docker 发布冒烟用于发布信心

它们在引导断言上重叠，但它们守护不同的失败类别。

## 建议设计

## 1. 添加 CI 友好的 Docker 冒烟工具

重构 `scripts/docker-onboard-smoke.sh` 使其可以在两种模式下运行：

- 交互模式
  - 当前行为
  - 流式输出日志并在前台等待手动检查
- CI 模式
  - 启动容器
  - 等待健康检查和认证引导
  - 打印机器可读的元数据
  - 退出同时保持容器运行供 Playwright 使用

推荐形态：

- 保持 `scripts/docker-onboard-smoke.sh` 作为公开入口
- 添加 `SMOKE_DETACH=true` 或 `--detach` 模式
- 发出包含以下内容的 JSON 或 `.env` 文件：
  - `SMOKE_BASE_URL`
  - `SMOKE_ADMIN_EMAIL`
  - `SMOKE_ADMIN_PASSWORD`
  - `SMOKE_CONTAINER_NAME`
  - `SMOKE_DATA_DIR`

工作流和 Playwright 测试随后可以消费发出的元数据，而非解析日志。

### 为什么这很重要

当前脚本总是尾随日志然后阻塞在 `wait "$LOG_PID"` 上。这对手动冒烟测试很方便，但对 CI 编排来说形态不对。

## 2. 添加专用的 Playwright 发布冒烟规格

为已发布的 Docker 安装创建第二个 Playwright 入口，例如：

- `tests/release-smoke/playwright.config.ts`
- `tests/release-smoke/docker-auth-onboarding.spec.ts`

此套件不应使用 Playwright `webServer`，因为应用服务器已在 Docker 内运行。

### 浏览器场景

第一个发布冒烟场景应验证：

1. 打开 `/`
2. 未认证用户被重定向到 `/auth`
3. 使用冒烟凭证登录
4. 没有公司时认证用户进入引导流程
5. 引导向导出现并显示预期的步骤标签
6. 创建公司
7. 使用 `process` 创建第一个智能体
8. 创建初始任务
9. 完成引导并打开创建的任务
10. 通过 API 验证：
    - 公司存在
    - CEO 智能体存在
    - 任务存在并分配给 CEO
11. 验证第一次心跳运行被触发：
    - 通过检查任务状态是否从初始状态改变，或
    - 通过检查智能体/运行 API 是否显示 CEO 的运行，或
    - 两者都检查

测试应容忍运行快速完成。因此，断言应接受：

- `queued`
- `running`
- `succeeded`

类似地，如果任务状态在断言运行前就已改变，也应接受任务的进展。

### 为什么用单独的规格而非复用 `tests/e2e/onboarding.spec.ts`

本地源码测试和发布冒烟测试有不同的假设：

- 不同的服务器生命周期
- 不同的认证路径
- 不同的部署模式
- 已发布的 npm 包而非本地工作区代码

试图将两者强制通过一个规格会使两者都更差。

## 3. 在 GitHub Actions 中添加发布冒烟工作流

添加专门针对此场景的工作流，最好是可复用的：

- `.github/workflows/release-smoke.yml`

推荐的触发器：

- `workflow_dispatch`
- `workflow_call`

推荐的输入：

- `paperclip_version`
  - `canary` 或 `latest`
- `host_port`
  - 可选，默认为 runner 安全端口
- `artifact_name`
  - 可选，用于更清晰的上传

### 任务大纲

1. 检出仓库
2. 安装 Node/pnpm
3. 安装 Playwright 浏览器依赖
4. 以分离模式用选定的 dist-tag 启动 Docker 冒烟工具
5. 针对返回的 base URL 运行发布冒烟 Playwright 套件
6. 始终收集诊断信息：
   - Playwright 报告
   - 截图
   - trace
   - `docker logs`
   - 工具元数据文件
7. 停止并移除容器

### 为什么使用可复用工作流

这让我们可以：

- 按需手动运行冒烟
- 从 `release.yml` 调用它
- 对 `canary` 和 `latest` 复用相同的任务

## 4. 增量集成到发布自动化

### 阶段 A：仅手动工作流

首先作为仅手动的工作流发布，以便在不阻断发布的情况下稳定工具和测试。

### 阶段 B：canary 发布后自动运行

在 `.github/workflows/release.yml` 中 `publish_canary` 成功后，调用可复用的发布冒烟工作流：

- `paperclip_version=canary`

这证明刚发布的公开 canary 确实能启动和引导。

### 阶段 C：稳定版发布后自动运行

在 `publish_stable` 成功后，用以下参数调用相同的工作流：

- `paperclip_version=latest`

这给我们发布后确认稳定版 dist-tag 是健康的。

### 重要细微差别

在稳定版发布之前无法从 npm 测试 `latest`，因为被测的包在 `latest` 下还不存在。所以 `latest` 冒烟是发布后验证，而非发布前门禁。

如果我们后续想要真正的稳定版发布前门禁，那应该是一个基于源码引用或本地构建包的冒烟任务。

## 5. 使诊断成为一等公民

此工作流只有在失败时能快速调试才有价值。

始终捕获：

- Playwright HTML 报告
- 失败时的 Playwright trace
- 失败时的最终截图
- 完整的 `docker logs` 输出
- 发出的冒烟元数据
- 可选的 `curl /api/health` 快照

没有这些，测试将变成不稳定的黑盒，人们将不再信任它。

## 实现计划

## 阶段 1：工具重构

文件：

- `scripts/docker-onboard-smoke.sh`
- 可选的 `scripts/lib/docker-onboard-smoke.sh` 或类似辅助脚本
- `doc/DOCKER.md`
- `doc/RELEASING.md`

任务：

1. 为 Docker 冒烟脚本添加分离/CI 模式。
2. 使脚本发出机器可读的连接元数据。
3. 保持当前的交互手动模式不变。
4. 为 CI 添加可靠的清理命令。

验收：

- 一次脚本调用可以启动已发布的 Docker 应用、自动引导它，并将控制权返回给调用者，附带足够的元数据用于浏览器自动化

## 阶段 2：浏览器发布冒烟套件

文件：

- `tests/release-smoke/playwright.config.ts`
- `tests/release-smoke/docker-auth-onboarding.spec.ts`
- 根 `package.json`

任务：

1. 为外部服务器测试添加专用的 Playwright 配置。
2. 实现登录 + 引导 + CEO 创建流程。
3. 断言 CEO 运行已创建或完成。
4. 添加根脚本，如：
   - `test:release-smoke`

验收：

- 套件在本地针对以下两者都通过：
  - `PAPERCLIPAI_VERSION=canary`
  - `PAPERCLIPAI_VERSION=latest`

## 阶段 3：GitHub Actions 工作流

文件：

- `.github/workflows/release-smoke.yml`

任务：

1. 添加手动和可复用的工作流入口。
2. 安装 Chromium 和 runner 依赖。
3. 以分离模式启动 Docker 冒烟。
4. 运行发布冒烟 Playwright 套件。
5. 上传诊断产物。

验收：

- 维护者可以手动为 `canary` 或 `latest` 运行工作流

## 阶段 4：发布工作流集成

文件：

- `.github/workflows/release.yml`
- `doc/RELEASING.md`

任务：

1. canary 发布后自动触发发布冒烟。
2. 稳定版发布后自动触发发布冒烟。
3. 文档化预期行为和失败处理。

验收：

- canary 发布自动产生已发布包的浏览器冒烟结果
- 稳定版发布自动产生 `latest` 的浏览器冒烟结果

## 阶段 5：未来扩展——真实模型支持的智能体验证

不是首次实现的一部分，但这应是确定性通道稳定后的下一层。

可能的添加：

- 第二个受仓库密钥门控的 Playwright 项目
- 在支持 Docker 的环境中验证真实的 `claude_local` 或 `codex_local` 适配器
- 断言 CEO 发布了真实的任务/评论产物
- 在带凭证的通道通过之前保留稳定版发布

在无 token 通道可信之前，这应保持可选。

## 验收标准

当实现的系统可以展示以下所有内容时，计划即为完成：

1. 已发布的 `paperclipai@canary` Docker 安装可以在 CI 中被 Playwright 冒烟测试。
2. 已发布的 `paperclipai@latest` Docker 安装可以在 CI 中被 Playwright 冒烟测试。
3. 测试使用冒烟凭证登录认证模式。
4. 测试为全新实例看到引导流程。
5. 测试在浏览器中完成引导流程。
6. 测试验证初始 CEO 智能体已创建。
7. 测试验证至少一次 CEO 心跳运行已触发。
8. 失败产生可操作的产物而非仅是一个红色任务。

## 风险和需做的决策

### 1. 快速进程运行可能在 UI 可见更新前完成

这是预期的。断言应优先通过 API 轮询运行存在/状态，而非仅依赖视觉指示器。

### 2. `latest` 冒烟是发布后的，非预防性的

这是测试已发布 dist-tag 本身的真实局限。它仍然有价值，但不应与发布前门禁混淆。

### 3. 不应将测试过度耦合到引导的装饰性文本

重要的契约是流程成功、创建的实体和运行创建。谨慎使用可见标签，尽可能优先使用稳定的语义选择器。

### 4. 保持冒烟适配器路径无趣

为了发布安全，第一个测试应使用最无趣的可运行适配器。这不是验证每个适配器的地方。

## 推荐的首个切片

如果我们想要最快产生价值的路径，按此顺序交付：

1. 为 `scripts/docker-onboard-smoke.sh` 添加分离模式
2. 添加一个认证登录 + 引导 + CEO 运行验证的 Playwright 规格
3. 添加手动 `release-smoke.yml`
4. 稳定后，将 canary 接入 `release.yml`
5. 之后，将稳定版 `latest` 冒烟接入 `release.yml`

这快速提供发布信心，而不会将第一个版本变成大规模的 CI 重新设计。
