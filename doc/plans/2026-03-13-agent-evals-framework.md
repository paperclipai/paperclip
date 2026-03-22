# 智能体评估框架计划

日期：2026-03-13

## 背景

我们需要对 Paperclip 实际交付的内容进行评估：

- 由适配器配置产生的智能体行为
- prompt 模板和引导 prompt
- 技能集和技能指令
- 模型选择
- 影响结果和成本的运行时策略选择

我们**不**主要需要一个微调管线。
我们需要一个回归框架来回答：

- 如果我们更改 prompt 或技能，智能体是否仍然做正确的事？
- 如果我们切换模型，什么变好了、变差了、还是变贵了？
- 如果我们优化 token，是否保留了任务结果？
- 我们能否随着时间从真实的 Paperclip 使用中扩展测试套件？

本计划基于：

- `doc/GOAL.md`
- `doc/PRODUCT.md`
- `doc/SPEC-implementation.md`
- `docs/agents-runtime.md`
- `doc/plans/2026-03-13-TOKEN-OPTIMIZATION-PLAN.md`
- Discussion #449: <https://github.com/paperclipai/paperclip/discussions/449>
- OpenAI 评估最佳实践: <https://developers.openai.com/api/docs/guides/evaluation-best-practices>
- Promptfoo 文档: <https://www.promptfoo.dev/docs/configuration/test-cases/> 和 <https://www.promptfoo.dev/docs/providers/custom-api/>
- LangSmith 复杂智能体评估文档: <https://docs.langchain.com/langsmith/evaluate-complex-agent>
- Braintrust 数据集/评分器文档: <https://www.braintrust.dev/docs/annotate/datasets> 和 <https://www.braintrust.dev/docs/evaluate/write-scorers>

## 建议

Paperclip 应采取**两阶段方法**：

1. **现在先用 Promptfoo** 做跨模型的窄范围 prompt 和技能行为评估。
2. **逐步发展为仓库本地的 TypeScript 第一方评估框架**，用于完整的 Paperclip 场景评估。

因此建议不再是"跳过 Promptfoo"，而是：

- 使用 Promptfoo 作为最快的引导层
- 将评估用例和测试数据保存在本仓库中
- 避免将 Promptfoo 配置作为最深层的长期抽象

更具体地说：

1. 规范的评估定义应存放在本仓库顶层 `evals/` 目录下。
2. `v0` 应使用 Promptfoo 跨模型和提供商运行聚焦的测试用例。
3. 长期框架应运行**真实的 Paperclip 场景**，针对预置的公司/任务/智能体，而不仅是原始 prompt 补全。
4. 评分模型应结合：
   - 确定性检查
   - 结构化评分标准打分
   - 候选方案与基线的成对判断
   - 来自规范化用量/成本遥测的效率指标
5. 框架应比较**包（bundle）**，而不仅是模型。

一个包（bundle）包含：

- 适配器类型
- 模型 id
- prompt 模板
- 引导 prompt 模板
- 技能允许列表 / 技能内容版本
- 相关运行时标志

这是正确的评估单元，因为这才是 Paperclip 中真正改变行为的东西。

## 为什么这是正确的形态

### 1. 我们需要评估系统行为，而不仅是 prompt 输出

纯 prompt 工具有用，但 Paperclip 的真实失败模式通常是：

- 选错了任务
- 错误的 API 调用序列
- 不当的委派
- 未遵守审批边界
- 过时会话行为
- 过度读取上下文
- 声称完成但未产出工件或评论

这些是控制平面行为。它们需要场景设置、执行和追踪检查。

### 2. 仓库已经是 TypeScript 为主

现有 monorepo 已使用：

- `pnpm`
- `tsx`
- `vitest`
- TypeScript 覆盖 server、UI、共享合约和适配器

TypeScript 优先的框架比引入 Python 优先的测试子系统更适合仓库和 CI。

Python 可以在后续作为可选项用于专业评分器或研究实验。

### 3. 我们需要跨提供商/模型比较而不锁定厂商

OpenAI 的指导方向是正确的：

- 尽早且频繁地评估
- 使用任务特定的评估
- 记录一切
- 偏好成对/比较式判断而非开放式评分

但 OpenAI 的 Evals API 不适合作为 Paperclip 的主要控制平面，因为我们的目标明确是多模型、多提供商。

### 4. 托管评估产品有用，Promptfoo 是正确的引导工具

当前权衡：

- Promptfoo 非常擅长本地的、仓库级别的 prompt/提供商矩阵和 CI 集成。
- LangSmith 在轨迹式智能体评估方面很强。
- Braintrust 有干净的数据集 + 评分器 + 实验模型，以及强大的 TypeScript 支持。

社区建议的方向是正确的：

- Promptfoo 让我们可以从小处开始
- 它支持简单的断言如 contains / not-contains / regex / 自定义 JS
- 它可以跨多个模型运行相同的用例
- 它支持 OpenRouter
- 它后续可以集成到 CI

这使它成为"这个 prompt/技能/模型变更是否明显导致回归？"的最佳 `v0` 工具。

但 Paperclip 仍应避免在我们自己的评估模型稳定之前，将托管平台或第三方配置格式作为核心抽象。

正确的做法是：

- 先用 Promptfoo 快速获胜
- 保持数据可移植且由仓库拥有
- 随着系统增长，围绕 Paperclip 概念构建薄的第一方框架
- 后续可选择导出到或集成其他工具

## 我们应该评估什么

我们应将评估分为四个层次。

### 第一层：确定性合约评估

这些不需要裁判模型。

示例：

- 智能体在分配的任务上发表评论
- 不在智能体所属公司之外进行变更
- 需要审批的操作不绕过审批流程
- 任务状态转换是合法的
- 输出包含必需的结构化字段
- 当任务需要工件时存在工件链接
- 在 API 支持增量后，增量场景不进行全线程重新获取

这些检查便宜、可靠，应是第一道防线。

### 第二层：单步行为评估

这些在隔离环境中测试窄范围行为。

示例：

- 从收件箱中选择正确的任务
- 写出合理的首条状态评论
- 决定请求审批而非直接行动
- 委派给正确的下属
- 识别阻塞状态并清晰报告

这些最接近 prompt 评估，但仍以 Paperclip 术语构建。

### 第三层：端到端场景评估

这些针对预置场景运行完整的心跳或短序列心跳。

示例：

- 新分配任务接收
- 长线程延续
- 提及触发的澄清
- 需要审批的招聘请求
- 经理级别升级
- 必须留下有意义任务更新的工作区编码任务

这些应评估最终状态和追踪质量。

### 第四层：效率和回归评估

这些不是"答案看起来好不好"的评估。而是"我们是否在改善成本/延迟的同时保持了质量？"的评估。

示例：

- 每次成功心跳的规范化输入 token
- 每个完成任务的规范化 token
- 会话复用率
- 全线程重新加载率
- 挂钟时间
- 每个成功场景的成本

此层对 token 优化工作尤为重要。

## 核心设计

## 1. 规范对象：`EvalCase`

每个评估用例应定义：

- 场景设置
- 目标包
- 执行模式
- 预期不变量
- 评分标准
- 标签/元数据

建议的结构：

```ts
type EvalCase = {
  id: string;
  description: string;
  tags: string[];
  setup: {
    fixture: string;
    agentId: string;
    trigger: "assignment" | "timer" | "on_demand" | "comment" | "approval";
  };
  inputs?: Record<string, unknown>;
  checks: {
    hard: HardCheck[];
    rubric?: RubricCheck[];
    pairwise?: PairwiseCheck[];
  };
  metrics: MetricSpec[];
};
```

重要的是，用例是关于 Paperclip 场景的，而不是独立的 prompt 字符串。

## 2. 规范对象：`EvalBundle`

建议的结构：

```ts
type EvalBundle = {
  id: string;
  adapter: string;
  model: string;
  promptTemplate: string;
  bootstrapPromptTemplate?: string;
  skills: string[];
  flags?: Record<string, string | number | boolean>;
};
```

每次比较运行都应说明测试了哪个包。

这避免了常见错误——说"模型 X 更好"，而实际变更是模型 + prompt + 技能 + 运行时行为。

## 3. 规范输出：`EvalTrace`

我们应捕获规范化的追踪用于评分：

- 运行 id
- 实际发送的 prompt
- 会话复用元数据
- 任务变更
- 创建的评论
- 请求的审批
- 创建的工件
- token/成本遥测
- 时间
- 原始输出

评分层不应需要抓取临时日志。

## 评分框架

## 1. 先做硬性检查

每个评估应首先进行通过/失败检查，可以立即使运行失效。

示例：

- 触及了错误的公司
- 跳过了必需的审批
- 未产生任务更新
- 返回了格式错误的结构化输出
- 在缺少必需工件的情况下将任务标记为完成

如果硬性检查失败，无论风格或裁判评分如何，场景都算失败。

## 2. 其次是评分标准打分

评分标准打分应使用窄范围的标准，而不是模糊的"这个有多好？"prompt。

好的评分维度：

- 任务理解
- 治理合规性
- 有用的进度沟通
- 正确的委派
- 完成证据
- 简洁性 / 不必要的冗长

每个评分标准应是小范围的 0-1 或 0-2 决策，而不是模糊的 1-10 等级。

## 3. 候选方案与基线的成对判断

OpenAI 的评估指导是正确的，LLM 在辨别方面比开放式生成更好。

因此对于非确定性质量检查，默认模式应为：

- 在用例上运行基线包
- 在相同用例上运行候选包
- 让裁判模型根据明确标准判断哪个更好
- 允许 `baseline`、`candidate` 或 `tie`

这比让裁判在没有锚点的情况下给出绝对质量分数要好。

## 4. 效率评分独立进行

不要将效率隐藏在单个混合质量分数中。

单独记录：

- 质量分数
- 成本分数
- 延迟分数

然后计算汇总决策，例如：

- 候选方案仅在质量不劣且效率改善时才可接受

这比一个神奇的单一数字更容易推理。

## 建议的决策规则

用于 PR 门控：

1. 无硬性检查回归。
2. 必需场景通过率无显著回归。
3. 关键评分维度无显著回归。
4. 如果变更面向 token 优化，要求目标场景的效率改善。

用于更深层的比较报告，展示：

- 通过率
- 成对胜/负/平
- 中位规范化 token
- 中位挂钟时间
- 成本差异

## 数据集策略

我们应明确从三个来源构建数据集。

### 1. 手工编写的种子用例

从这里开始。

这些应覆盖核心产品不变量：

- 分配任务接收
- 状态更新
- 阻塞报告
- 委派
- 审批请求
- 跨公司访问拒绝
- 任务评论跟进

这些小巧、清晰且稳定。

### 2. 生产环境衍生用例

按照 OpenAI 的指导，我们应记录一切并从真实使用中挖掘评估用例。

Paperclip 应通过将真实运行提升为用例来扩展评估覆盖，当我们看到：

- 回归
- 有意义的失败
- 边界情况
- 值得保留的高价值成功模式

初始版本可以是手动的：

- 获取一个真实运行
- 脱敏/规范化
- 转换为 `EvalCase`

后续我们可以自动化追踪到用例的生成。

### 3. 对抗性和护栏用例

这些应有意探测失败模式：

- 审批绕过尝试
- 跨公司引用
- 过时上下文陷阱
- 无关的长线程
- 评论中的误导性指令
- 冗长陷阱

这是 Promptfoo 式红队思想后续可以派上用场的地方，但不是第一批次。

## 仓库布局

推荐的初始布局：

```text
evals/
  README.md
  promptfoo/
    promptfooconfig.yaml
    prompts/
    cases/
  cases/
    core/
    approvals/
    delegation/
    efficiency/
  fixtures/
    companies/
    issues/
  bundles/
    baseline/
    experiments/
  runners/
    scenario-runner.ts
    compare-runner.ts
  scorers/
    hard/
    rubric/
    pairwise/
  judges/
    rubric-judge.ts
    pairwise-judge.ts
  lib/
    types.ts
    traces.ts
    metrics.ts
  reports/
    .gitignore
```

为什么选择顶层 `evals/`：

- 让评估感觉是一等公民
- 避免将它们隐藏在 `server/` 中，即使它们跨越适配器和运行时行为
- 为后续的 TS 和可选 Python 辅助工具留出空间
- 为 Promptfoo `v0` 配置加上后续的第一方运行器提供干净的位置

## 执行模型

框架应支持三种模式。

### 模式 A：低成本本地烟雾测试

目的：

- 在 PR 上运行
- 保持低成本
- 捕获明显的回归

特征：

- 5 到 20 个用例
- 1 或 2 个包
- 主要是硬性检查和窄范围评分标准

### 模式 B：候选与基线比较

目的：

- 在合并前评估 prompt/技能/模型变更

特征：

- 成对运行
- 启用成对判断
- 质量 + 效率差异报告

### 模式 C：每晚更广泛的矩阵

目的：

- 比较多个模型和包
- 积累历史基准数据

特征：

- 更大的用例集
- 多个模型
- 更昂贵的评分标准/成对判断

## CI 和开发者工作流

建议的命令：

```sh
pnpm evals:smoke
pnpm evals:compare --baseline baseline/codex-default --candidate experiments/codex-lean-skillset
pnpm evals:nightly
```

PR 行为：

- 对 prompt/技能/适配器/运行时变更运行 `evals:smoke`
- 可选择对标记的 PR 或手动运行触发 `evals:compare`

每晚行为：

- 运行更大的矩阵
- 保存报告工件
- 展示通过率、成对胜出和效率的趋势线

## 框架比较

## Promptfoo

对 Paperclip 的最佳用途：

- prompt 级别的微评估
- 提供商/模型比较
- 快速本地 CI 集成
- 自定义 JS 断言和自定义提供商
- 单个技能或单个智能体工作流的引导层评估

本次建议中的变化：

- Promptfoo 现在是推荐的**起点**
- 特别适用于"一个技能、几个用例、跨模型比较"

为什么它仍然不应是唯一的长期系统：

- 它的主要抽象仍然是 prompt/提供商/测试用例导向的
- Paperclip 需要场景设置、控制平面状态检查和多步追踪作为一等概念

建议：

- 首先使用 Promptfoo
- 将 Promptfoo 配置和用例存储在仓库的 `evals/promptfoo/` 下
- 使用自定义 JS/TS 断言，必要时使用调用 Paperclip 场景运行器的自定义提供商
- 一旦我们超越 prompt 级别的评估，不要将 Promptfoo YAML 作为唯一的规范 Paperclip 评估格式

## LangSmith

它做对的地方：

- 最终响应评估
- 轨迹评估
- 单步评估

为什么今天不作为主要系统：

- 更适合已经以 LangChain/LangGraph 为中心的团队
- 在我们自己的评估模型稳定之前引入了托管/外部工作流引力

建议：

- 复制其轨迹/最终/单步分类法
- 不将该平台作为默认要求采用

## Braintrust

它做对的地方：

- TypeScript 支持
- 干净的数据集/任务/评分器模型
- 生产日志到数据集
- 随时间的实验比较

为什么今天不作为主要系统：

- 仍将规范数据集和审查工作流外部化
- 我们尚未达到托管实验管理应定义系统形态的成熟度

建议：

- 借鉴其数据集/评分器/实验心智模型
- 在我们需要大规模托管审查和实验历史时重新评估

## OpenAI Evals / Evals API

它做对的地方：

- 强大的评估原则
- 强调任务特定的评估
- 持续评估心态

为什么不作为主要系统：

- Paperclip 必须跨模型/提供商进行比较
- 我们不希望主要评估运行器耦合到一个模型厂商

建议：

- 使用其指导
- 不将其作为核心 Paperclip 评估运行时

## 首个实现切片

第一个版本应有意保持小巧。

## 第零阶段：Promptfoo 引导

构建：

- `evals/promptfoo/promptfooconfig.yaml`
- 5 到 10 个聚焦于一个技能或一个智能体工作流的用例
- 使用我们最关心的提供商的模型矩阵
- 主要是确定性断言：
  - contains
  - not-contains
  - regex
  - 自定义 JS 断言

目标范围：

- 一个技能，或一个窄工作流如分配任务接收 / 首条状态更新
- 跨多个模型比较少量的包

成功标准：

- 我们可以运行一个命令并跨模型比较输出
- prompt/技能回归快速变得可见
- 团队在构建更重基础设施之前获得信号

## 第一阶段：骨架和核心用例

构建：

- `evals/` 脚手架
- `EvalCase`、`EvalBundle`、`EvalTrace` 类型
- 用于预置本地用例的场景运行器
- 10 个手工编写的核心用例
- 仅硬性检查

目标用例：

- 分配任务接收
- 写进度评论
- 需要时请求审批
- 遵守公司边界
- 报告阻塞状态
- 避免在没有工件/评论证据的情况下标记为完成

成功标准：

- 开发者可以运行本地烟雾测试套件
- prompt/技能变更可以确定性地使套件失败
- Promptfoo `v0` 用例可以干净地迁移到或与此层共存

## 第二阶段：成对判断和评分标准层

构建：

- 评分标准评分器接口
- 成对裁判运行器
- 候选与基线比较命令
- markdown/html 报告输出

成功标准：

- 模型/prompt 包变更产生可读的差异报告
- 我们可以在精选场景上判断"更好"、"更差"或"相同"

## 第三阶段：效率集成

构建：

- 规范化 token/成本指标纳入评估追踪
- 成本和延迟比较
- token 优化工作的效率门控

依赖：

- 这应与 `2026-03-13-TOKEN-OPTIMIZATION-PLAN.md` 中的遥测规范化工作对齐

成功标准：

- 质量和效率可以一起判断
- token 减少工作不再依赖于主观改善

## 第四阶段：生产用例摄入

构建：

- 将真实运行提升为新评估用例的工具
- 元数据标记
- 失败语料库增长流程

成功标准：

- 评估套件从真实产品行为中增长，而不是停留在合成数据

## 初始用例分类

我们应从以下分类开始：

1. `core.assignment_pickup`
2. `core.progress_update`
3. `core.blocked_reporting`
4. `governance.approval_required`
5. `governance.company_boundary`
6. `delegation.correct_report`
7. `threads.long_context_followup`
8. `efficiency.no_unnecessary_reloads`

这足以开始捕获我们真正关心的回归类别。

## 重要护栏

### 1. 不要仅依赖裁判模型

每个重要场景首先需要确定性检查。

### 2. 不要用单个嘈杂的分数来门控 PR

使用通过/失败不变量加少量稳定的评分标准或成对检查。

### 3. 不要将基准分数与产品质量混淆

套件必须从真实运行中持续增长，否则它会变成玩具基准。

### 4. 不要仅评估最终输出

轨迹对智能体很重要：

- 它们是否调用了正确的 Paperclip API？
- 它们是否请求了审批？
- 它们是否沟通了进度？
- 它们是否选择了正确的任务？

### 5. 不要让框架受厂商约束

我们的评估模型应能在以下变更中存续：

- 裁判提供商
- 候选提供商
- 适配器实现
- 托管工具选择

## 开放问题

1. 第一个场景运行器应该通过 HTTP 调用真实服务器，还是直接在进程内调用服务？
   我的建议：先从进程内开始以求速度，模型稳定后再添加 HTTP 模式覆盖。

2. 我们应该在 v1 中支持 Python 评分器吗？
   我的建议：不。保持 v1 全 TypeScript。

3. 我们应该提交基线输出吗？
   我的建议：提交用例定义和包定义，但将运行工件排除在 git 之外。

4. 我们应该立即添加托管实验跟踪吗？
   我的建议：不。在本地框架证明有用后再重新评估。

## 最终建议

先用 Promptfoo 进行即时的、窄范围的模型和 prompt 比较，然后发展为 TypeScript 的第一方 `evals/` 框架，评估 **Paperclip 场景和包**，而不仅是 prompt。

使用这种结构：

- Promptfoo 用于 `v0` 引导
- 确定性硬性检查作为基础
- 评分标准和成对判断用于非确定性质量
- 规范化效率指标作为独立轴
- 仓库本地的数据集从真实运行中增长

有选择地使用外部工具：

- Promptfoo 作为窄范围 prompt/提供商测试的初始路径
- Braintrust 或 LangSmith 在我们需要托管实验管理时使用

但将规范的评估模型保留在 Paperclip 仓库内，并与 Paperclip 的实际控制平面行为对齐。
