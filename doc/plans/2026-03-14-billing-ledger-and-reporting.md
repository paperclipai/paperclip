# 计费台账与报表

## 背景

Paperclip 目前将模型支出存储在 `cost_events` 中，将运行运营状态存储在 `heartbeat_runs` 中。
这种拆分本身没问题，但当前的报表代码试图通过混合两张表来推断计费语义：

- `cost_events` 知道提供商、模型、token 数和美元数
- `heartbeat_runs.usage_json` 知道部分按运行的计费元数据
- `heartbeat_runs.usage_json` 目前 **不** 携带足够规范化的计费维度来支持诚实的提供商级报表

一旦公司使用多个提供商、多个计费渠道或多种计费模式，这就会变得不正确。

示例：

- 直接使用 OpenAI API
- Claude 订阅用量，零边际美元成本
- 订阅超额使用，涉及美元和 token
- OpenRouter 计费，计费方是 OpenRouter，但上游提供商是 Anthropic 或 OpenAI

系统需要支持：

- 美元报表
- token 报表
- 订阅包含用量
- 订阅超额
- 直接计量 API 用量
- 未来的聚合器计费（如 OpenRouter）

## 产品决策

`cost_events` 成为报表的规范计费和用量台账。

`heartbeat_runs` 保留为运营执行日志。它可以保留镜像的计费元数据用于调试和记录回放，但报表不得从 `heartbeat_runs.usage_json` 重建计费语义。

## 决策：一个台账还是两个

我们 **不** 需要两张表来解决当前 PR 的问题。
对于请求级推理报表，只要 `cost_events` 携带正确的维度就够了：

- 上游提供商
- 计费方
- 计费类型
- 模型
- token 字段
- 计费金额

这就是为什么第一轮实现扩展 `cost_events` 而不是立即引入第二张表。

但是，如果 Paperclip 需要覆盖聚合器和托管 AI 平台的完整计费面，那么仅靠 `cost_events` 是不够的。
有些费用无法干净地表示为单个模型推理事件：

- 账户充值和积分购买
- 购买时收取的平台费
- BYOK 平台费（账户级或阈值制）
- 预付积分过期、退款和调整
- 预留吞吐量承诺
- 微调、训练、模型导入和存储费用
- 网关日志记录或其他不可归因于单个请求/响应对的平台开销

所以决策是：

- 近期：保持 `cost_events` 作为推理和用量台账
- 下一阶段：为非推理财务事件添加 `finance_events`

这是刻意区分：

- 用量和推理核算
- 账户级和平台级财务核算

这种分离使请求报表保持诚实，而无需将发票语义强加到本来就不是请求范围的行上。

## 外部动机和来源

这个模型的需求并非理论推导。
它直接来源于 Paperclip 需要支持的提供商和聚合器的计费系统。

### OpenRouter

来源 URL：

- https://openrouter.ai/docs/faq#credit-and-billing-systems
- https://openrouter.ai/pricing

截至 2026 年 3 月 14 日的相关计费行为：

- OpenRouter 传递底层推理定价并从购买的积分中扣除请求费用。
- OpenRouter 在购买积分时收取 5.5% 的费用，最低 $0.80。
- 加密货币支付收取 5% 的费用。
- BYOK 在免费请求阈值之后有自己的费用模型。
- OpenRouter 计费在 OpenRouter 账户级别聚合，即使上游提供商是 Anthropic、OpenAI、Google 或其他提供商。

对 Paperclip 的影响：

- 请求用量属于 `cost_events`
- 积分购买、购买费用、BYOK 费用、退款和过期属于 `finance_events`
- `biller=openrouter` 必须与 `provider=anthropic|openai|google|...` 保持区分

### Cloudflare AI Gateway 统一计费

来源 URL：

- https://developers.cloudflare.com/ai-gateway/features/unified-billing/

截至 2026 年 3 月 14 日的相关计费行为：

- 统一计费允许用户调用多个上游提供商，同时接收单一 Cloudflare 账单。
- 用量从 Cloudflare 充值的积分中支付。
- Cloudflare 支持手动充值和自动充值阈值。
- 消费限额可以按日、周或月边界停止请求处理。
- 统一计费流量可以使用 Cloudflare 托管的凭证，而非用户的直接提供商密钥。

对 Paperclip 的影响：

- 请求用量需要 `biller=cloudflare`
- 上游提供商仍需单独保留
- Cloudflare 积分充值和相关账户级事件不是推理行，不应强制塞入 `cost_events`
- 配额和限额报表必须支持计费方级别的控制，而不仅仅是上游提供商限额

### Amazon Bedrock

来源 URL：

- https://aws.amazon.com/bedrock/pricing/

截至 2026 年 3 月 14 日的相关计费行为：

- Bedrock 支持按需和批量定价。
- Bedrock 定价因区域而异。
- 某些定价层级相对标准定价有溢价或折扣
- 预留吞吐量是基于承诺的，而非基于请求的
- 自定义模型导入使用按分钟计费的自定义模型单元（Custom Model Units），并有月度存储费
- 导入的模型副本一旦激活后按 5 分钟窗口计费
- 定制和微调在正常推理之外引入了训练和托管模型费用

对 Paperclip 的影响：

- 正常的 token 化推理适合放在 `cost_events`
- 预留吞吐量、自定义模型单元费用、训练和存储费用需要 `finance_events`
- 区域和定价层级需要在财务模型中作为一等维度

## 台账边界

为了保持系统一致性，表的边界应该是明确的。

### `cost_events`

将 `cost_events` 用于请求范围的用量和推理费用：

- 每个可计费或有用量的运行事件一行
- provider/model/biller/billingType/tokens/cost
- 可选关联 `heartbeat_run_id`
- 支持直接 API、订阅、超额、OpenRouter 路由推理、Cloudflare 路由推理和 Bedrock 按需推理

### `finance_events`

将 `finance_events` 用于账户范围或平台范围的财务事件：

- 积分购买
- 充值
- 退款
- 费用
- 过期
- 预留容量
- 训练
- 模型导入
- 存储
- 发票调整

这些行可能有也可能没有相关的模型、提供商或运行 ID。
试图将它们强制塞入 `cost_events` 会创建虚假请求行，或创建含大量空值的行，其含义与推理用量根本不同。

## 规范计费维度

每个持久化的计费事件应建模四个独立轴：

1. 用量提供商
   执行工作的上游提供商。
   示例：`openai`、`anthropic`、`google`。

2. 计费方
   收取用量费用的系统。
   示例：`openai`、`anthropic`、`openrouter`、`cursor`、`chatgpt`。

3. 计费类型
   应用于事件的定价模式。
   初始规范值：
   - `metered_api`
   - `subscription_included`
   - `subscription_overage`
   - `credits`
   - `fixed`
   - `unknown`

4. 度量
   用量和计费必须都可存储：
   - `input_tokens`
   - `output_tokens`
   - `cached_input_tokens`
   - `cost_cents`

这些维度是独立的。
例如，一个事件可以是：

- provider: `anthropic`
- biller: `openrouter`
- billing type: `metered_api`
- tokens: 非零
- cost cents: 非零

或：

- provider: `anthropic`
- biller: `anthropic`
- billing type: `subscription_included`
- tokens: 非零
- cost cents: `0`

## 数据库变更

扩展 `cost_events`：

- `heartbeat_run_id uuid null references heartbeat_runs.id`
- `biller text not null default 'unknown'`
- `billing_type text not null default 'unknown'`
- `cached_input_tokens int not null default 0`

保持 `provider` 作为上游用量提供商。
不要将 `provider` 重载为计费方。

为账户级财务事件添加未来的 `finance_events` 表，字段大致如下：

- `company_id`
- `occurred_at`
- `event_kind`
- `direction`
- `biller`
- `provider nullable`
- `execution_adapter_type nullable`
- `pricing_tier nullable`
- `region nullable`
- `model nullable`
- `quantity nullable`
- `unit nullable`
- `amount_cents`
- `currency`
- `estimated`
- `related_cost_event_id nullable`
- `related_heartbeat_run_id nullable`
- `external_invoice_id nullable`
- `metadata_json nullable`

添加索引：

- `(company_id, biller, occurred_at)`
- `(company_id, provider, occurred_at)`
- `(company_id, heartbeat_run_id)` 如果按运行去重报表仍然常见

## 共享契约变更

### 共享类型

添加共享计费类型联合并用以下字段丰富 cost 类型：

- `heartbeatRunId`
- `biller`
- `billingType`
- `cachedInputTokens`

更新报表响应类型，使提供商明细直接反映台账数据，而非推断的运行元数据。

### 校验器

扩展 `createCostEventSchema` 以接受：

- `heartbeatRunId`
- `biller`
- `billingType`
- `cachedInputTokens`

默认值：

- `biller` 默认为 `provider`
- `billingType` 默认为 `unknown`
- `cachedInputTokens` 默认为 `0`

## 适配器契约变更

扩展适配器执行结果，使其可以报告：

- `biller`
- 更丰富的计费类型值

向后兼容：

- 现有适配器值 `api` 和 `subscription` 视为遗留别名
- 映射 `api -> metered_api`
- 映射 `subscription -> subscription_included`

未来的适配器可以直接发出规范值。

OpenRouter 支持将使用：

- `provider` = 已知时为上游提供商
- `biller` = `openrouter`
- `billingType` = `metered_api`，除非 OpenRouter 后续公开另一种计费模式

Cloudflare 统一计费支持将使用：

- `provider` = 已知时为上游提供商
- `biller` = `cloudflare`
- `billingType` = `credits` 或 `metered_api`，取决于规范化的请求计费契约

Bedrock 支持将使用：

- `provider` = 上游提供商或 `aws_bedrock`，取决于适配器形态
- `biller` = `aws_bedrock`
- `billingType` = 推理行的请求范围模式
- `finance_events` 用于预留、训练、导入和存储费用

## 写入路径变更

### 心跳创建的事件

当一次心跳运行产生用量或支出时：

1. 规范化适配器计费元数据
2. 向 `cost_events` 写入一条台账行
3. 附加 `heartbeat_run_id`
4. 设置 `provider`、`biller`、`billing_type`、token 字段和 `cost_cents`

写入路径不应再依赖后续从 `heartbeat_runs` 进行的推断。

### 手动 API 创建的事件

手动创建 cost event 仍然受支持。
这些事件可能有 `heartbeatRunId = null`。

规则：

- `provider` 仍然是必需的
- `biller` 默认为 `provider`
- `billingType` 默认为 `unknown`

## 报表变更

### 服务端

重构报表查询，仅使用 `cost_events`。

#### `summary`

- 合计 `cost_cents`

#### `by-agent`

- 从 `cost_events` 合计费用和 token 字段
- 使用 `count(distinct heartbeat_run_id)` 按计费类型过滤来统计运行次数
- 使用按计费类型过滤的 token 合计来统计订阅用量

#### `by-provider`

- 按 `provider`、`model` 分组
- 直接从台账合计费用和 token 字段
- 从 `cost_events.billing_type` 派生计费类型切片
- 绝不从无关的 `heartbeat_runs` 进行按比例分摊

#### 未来的 `by-biller`

- 按 `biller` 分组
- 这是发票和订阅问责的正确视图

#### `window-spend`

- 继续使用 `cost_events`

#### 项目归属

目前保持当前的项目归属逻辑，但尽可能优先使用 `cost_events.heartbeat_run_id` 作为关联锚点。

## UI 变更

### 原则

- 支出、用量和配额是相关但不同的概念
- 配额获取缺失不等同于"没有配额"
- 提供商和计费方是不同的维度

### 即时 UI 变更

1. 保持当前成本页面结构。
2. 仅通过读取台账支撑的值使提供商卡片准确。
3. 明确显示提供商配额获取错误，而非丢弃它们。

### 后续 UI 方向

长期看板 UI 应公开：

- 支出
  按计费方、提供商、模型、智能体、项目的美元数
- 用量
  按提供商、模型、智能体、项目的 token 数
- 配额
  实时提供商或计费方限额、积分和重置窗口
- 财务事件
  积分购买、充值、费用、退款、承诺、存储和其他非推理费用

## 迁移计划

迁移行为：

- 添加带默认值的非破坏性新列
- 回填现有行：
  - `biller = provider`
  - `billing_type = 'unknown'`
  - `cached_input_tokens = 0`
  - `heartbeat_run_id = null`

**不要** 尝试从 `heartbeat_runs` 回填历史提供商级订阅归属。
那些数据从未以所需维度存储。

## 测试计划

添加或更新以下测试：

1. 心跳创建的台账行持久化 `heartbeatRunId`、`biller`、`billingType` 和缓存 token
2. 遗留适配器计费值正确映射
3. 提供商报表仅使用台账数据
4. 多提供商公司不会交叉归属订阅用量
5. 零美元订阅用量仍出现在 token 报表中
6. 配额获取失败渲染明确的 UI 状态
7. 手动 cost event 仍然正确校验和写入
8. 计费方报表保持上游提供商明细分离
9. OpenRouter 样式的行可以显示 `biller=openrouter` 并使用非 OpenRouter 的上游提供商
10. Cloudflare 样式的行可以显示 `biller=cloudflare` 并保留上游提供商身份
11. 未来的 `finance_events` 聚合在不需要模型或运行 ID 的情况下处理非请求费用

## 交付计划

### 步骤 1

- 落地台账契约和查询重写
- 使当前成本页面正确

### 步骤 2

- 添加面向计费方的报表端点和 UI

### 步骤 3

- 将 OpenRouter 和任何未来聚合器适配器接入同一契约

### 步骤 4

- 如果适配器级分组成为产品需求，则将 `executionAdapterType` 添加到持久化的成本报表中

### 步骤 5

- 引入 `finance_events`
- 添加非推理核算端点
- 在推理支出和用量旁边添加平台/账户费用 UI

## 本次变更的非目标

- 多币种支持
- 发票对账
- 超出持久化计费成本的提供商特定成本估算
- 替换 `heartbeat_runs` 作为运营运行记录
