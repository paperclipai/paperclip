# 计费账本与报告

## 背景

Paperclip 目前将模型费用存储在 `cost_events` 中，将运行操作状态存储在 `heartbeat_runs` 中。
这种拆分本身没有问题，但当前的报告代码试图通过混合使用这两张表来推断计费语义：

- `cost_events` 包含提供商、模型、token 数量和金额信息
- `heartbeat_runs.usage_json` 包含部分每次运行的计费元数据
- `heartbeat_runs.usage_json` 目前**不**包含足够规范化的计费维度，无法支持准确的提供商级报告

一旦某家公司使用了多个提供商、多个计费渠道或多种计费模式，现有系统就会出现错误。

示例：

- 直接使用 OpenAI API
- Claude 订阅用量，边际费用为零
- 订阅超额使用，含金额和 token
- OpenRouter 计费，其中计费方为 OpenRouter，但上游提供商是 Anthropic 或 OpenAI

系统需要支持：

- 金额报告
- token 报告
- 订阅内含用量
- 订阅超额用量
- 直接计量 API 用量
- 未来的聚合商计费（如 OpenRouter）

## 产品决策

`cost_events` 成为报告所用的权威计费与用量账本。

`heartbeat_runs` 保持为运行操作日志。它可以保留镜像的计费元数据用于调试和记录，但报告不得从 `heartbeat_runs.usage_json` 中重建计费语义。

## 决策：单一账本还是两张表

解决当前 PR 的问题**不需要**两张表。
对于请求级推理报告，只要 `cost_events` 携带了正确的维度即可满足需求：

- 上游提供商
- 计费方
- 计费类型
- 模型
- token 字段
- 计费金额

这就是为什么第一阶段实现选择扩展 `cost_events`，而不是立即引入第二张表。

但是，如果 Paperclip 需要覆盖聚合商和托管 AI 平台的完整计费面，则 `cost_events` 单独是不够的。
某些费用无法简洁地表示为单次模型推理事件：

- 账户充值和积分购买
- 购买时收取的平台费用
- 账户级或基于阈值的 BYOK 平台费用
- 预付积分到期、退款和调整
- 预留吞吐量承诺
- 微调、训练、模型导入和存储费用
- 网关日志记录或其他无法归因于单次提示/响应对的平台开销

因此，决策如下：

- 近期：保留 `cost_events` 作为推理和用量账本
- 下一阶段：添加 `finance_events` 用于非推理类财务事件

这是有意为之的拆分，区分了：

- 用量与推理会计
- 账户级和平台级财务会计

这种分离确保请求报告的准确性，避免将从未属于请求范围的行强行套入发票语义。

## 外部动因与来源

对此模型的需求并非纯粹理论性的。
它直接来源于 Paperclip 需要支持的各提供商和聚合商的计费系统。

### OpenRouter

来源 URL：

- https://openrouter.ai/docs/faq#credit-and-billing-systems
- https://openrouter.ai/pricing

截至 2026 年 3 月 14 日的相关计费行为：

- OpenRouter 转发底层推理定价，并从已购买的积分中扣除请求费用。
- 购买积分时，OpenRouter 收取 5.5% 的手续费，最低 0.80 美元。
- 加密货币支付收取 5% 的手续费。
- BYOK 在超出免费请求阈值后采用其自有收费模式。
- 即使上游提供商是 Anthropic、OpenAI、Google 或其他提供商，OpenRouter 的计费也在 OpenRouter 账户层面进行汇总。

对 Paperclip 的影响：

- 请求用量归入 `cost_events`
- 积分购买、购买手续费、BYOK 费用、退款和到期归入 `finance_events`
- `biller=openrouter` 必须与 `provider=anthropic|openai|google|...` 保持明确区分

### Cloudflare AI Gateway 统一计费

来源 URL：

- https://developers.cloudflare.com/ai-gateway/features/unified-billing/

截至 2026 年 3 月 14 日的相关计费行为：

- 统一计费允许用户调用多个上游提供商，同时只收到一张 Cloudflare 账单。
- 用量从 Cloudflare 充值的积分中支付。
- Cloudflare 支持手动充值和自动充值阈值。
- 消费限额可按日、周或月边界停止请求处理。
- 统一计费流量可使用 Cloudflare 管理的凭证，而非用户的直接提供商密钥。

对 Paperclip 的影响：

- 请求用量需要设置 `biller=cloudflare`
- 上游提供商仍需单独保留
- Cloudflare 积分充值及相关账户级事件不属于推理行，不应强行写入 `cost_events`
- 配额和限额报告必须支持计费方级别的控制，而不仅仅是上游提供商的限制

### Amazon Bedrock

来源 URL：

- https://aws.amazon.com/bedrock/pricing/

截至 2026 年 3 月 14 日的相关计费行为：

- Bedrock 支持按需定价和批量定价。
- Bedrock 定价因区域而异。
- 部分定价层级相对标准定价有溢价或折扣
- 预留吞吐量基于承诺而非按请求计费
- 自定义模型导入使用自定义模型单元（Custom Model Units），按分钟计费，并收取月度存储费
- 导入的模型副本激活后以 5 分钟为窗口进行计费
- 自定义和微调会在正常推理之外引入训练和托管模型费用

对 Paperclip 的影响：

- 普通 token 化推理适合放入 `cost_events`
- 预留吞吐量、自定义模型单元费用、训练和存储费用需要使用 `finance_events`
- 区域和定价层级需要作为财务模型中的一级维度

## 账本边界

为保持系统的一致性，表的边界应当明确定义。

### `cost_events`

将 `cost_events` 用于请求范围内的用量和推理费用：

- 每个可计费或产生用量的运行事件对应一行
- provider/model/biller/billingType/tokens/cost
- 可选关联 `heartbeat_run_id`
- 支持直接 API、订阅、超额用量、OpenRouter 路由推理、Cloudflare 路由推理和 Bedrock 按需推理

### `finance_events`

将 `finance_events` 用于账户范围或平台范围内的财务事件：

- 积分购买
- 充值
- 退款
- 手续费
- 到期
- 预留容量
- 训练
- 模型导入
- 存储
- 发票调整

这些行可能包含或不包含关联的模型、提供商或运行 ID。
若强行将它们写入 `cost_events`，要么会产生虚假的请求行，要么会产生大量空字段的行，其含义与推理用量有根本性的不同。

## 标准计费维度

每个持久化的计费事件应对四个独立轴进行建模：

1. 用量提供商
   执行工作的上游提供商模型所属方。
   示例：`openai`、`anthropic`、`google`。

2. 计费方
   对用量进行收费的系统。
   示例：`openai`、`anthropic`、`openrouter`、`cursor`、`chatgpt`。

3. 计费类型
   应用于该事件的定价模式。
   初始标准值：
   - `metered_api`
   - `subscription_included`
   - `subscription_overage`
   - `credits`
   - `fixed`
   - `unknown`

4. 度量指标
   用量和计费数据都必须可存储：
   - `input_tokens`
   - `output_tokens`
   - `cached_input_tokens`
   - `cost_cents`

这些维度彼此独立。
例如，一个事件可以是：

- provider: `anthropic`
- biller: `openrouter`
- billing type: `metered_api`
- tokens: 非零
- cost cents: 非零

或者：

- provider: `anthropic`
- biller: `anthropic`
- billing type: `subscription_included`
- tokens: 非零
- cost cents: `0`

## Schema 变更

扩展 `cost_events`，添加以下字段：

- `heartbeat_run_id uuid null references heartbeat_runs.id`
- `biller text not null default 'unknown'`
- `billing_type text not null default 'unknown'`
- `cached_input_tokens int not null default 0`

保留 `provider` 作为上游用量提供商字段。
不要将 `provider` 重载为计费方的含义。

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
- `(company_id, heartbeat_run_id)`（如果不同运行的报告仍然常见）

## 共享契约变更

### 共享类型

添加共享计费类型联合，并在 cost 类型中补充：

- `heartbeatRunId`
- `biller`
- `billingType`
- `cachedInputTokens`

更新报告响应类型，使提供商分解直接反映账本数据，而非通过推断运行元数据得出。

### 验证器

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

扩展适配器执行结果，使其能够报告：

- `biller`
- 更丰富的计费类型值

向后兼容性：

- 现有适配器值 `api` 和 `subscription` 被视为遗留别名
- 映射 `api -> metered_api`
- 映射 `subscription -> subscription_included`

未来的适配器可以直接发出标准值。

OpenRouter 支持将使用：

- `provider` = 已知时为上游提供商
- `biller` = `openrouter`
- `billingType` = `metered_api`，除非 OpenRouter 日后公开其他计费模式

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

当心跳运行产生用量或费用时：

1. 规范化适配器计费元数据
2. 向 `cost_events` 写入一条账本记录
3. 附加 `heartbeat_run_id`
4. 设置 `provider`、`biller`、`billing_type`、token 字段和 `cost_cents`

写入路径不应再依赖后续从 `heartbeat_runs` 推断数据。

### 手动 API 创建的事件

手动创建 cost 事件的功能仍然受支持。
这些事件的 `heartbeatRunId` 可以为 `null`。

规则：

- `provider` 仍为必填项
- `biller` 默认为 `provider`
- `billingType` 默认为 `unknown`

## 报告变更

### 服务端

重构报告查询，仅使用 `cost_events`。

#### `summary`

- 对 `cost_cents` 求和

#### `by-agent`

- 从 `cost_events` 汇总费用和 token 字段
- 按计费类型过滤后使用 `count(distinct heartbeat_run_id)` 统计运行次数
- 按计费类型过滤后使用 token 总量统计订阅用量

#### `by-provider`

- 按 `provider`、`model` 分组
- 直接从账本汇总费用和 token 字段
- 从 `cost_events.billing_type` 派生计费类型切片
- 绝不从无关的 `heartbeat_runs` 中按比例分配

#### 未来的 `by-biller`

- 按 `biller` 分组
- 这是发票和订阅核查的正确视图

#### `window-spend`

- 继续使用 `cost_events`

#### 项目归因

暂时保留当前的项目归因逻辑，但尽可能优先使用 `cost_events.heartbeat_run_id` 作为联接锚点。

## UI 变更

### 原则

- 消费、用量和配额相互关联，但各有区别
- 配额获取失败不等同于”无配额”
- 提供商和计费方是不同的维度

### 即时 UI 变更

1. 保留当前费用页面结构。
2. 通过仅读取账本支撑的值，使提供商卡片显示准确数据。
3. 明确显示提供商配额获取错误，而不是直接丢弃。

### 后续 UI 方向

长期的 board UI 应展示：

- 消费
  按计费方、提供商、模型、代理、项目划分的金额
- 用量
  按提供商、模型、代理、项目划分的 token 数量
- 配额
  实时提供商或计费方限额、积分和重置窗口
- 财务事件
  积分购买、充值、手续费、退款、承诺、存储及其他非推理费用

## 迁移计划

迁移行为：

- 添加带有默认值的新非破坏性字段
- 回填现有记录：
  - `biller = provider`
  - `billing_type = 'unknown'`
  - `cached_input_tokens = 0`
  - `heartbeat_run_id = null`

**不要**尝试从 `heartbeat_runs` 回填历史提供商级订阅归因数据。
这些数据从未以所需的维度存储过。

## 测试计划

添加或更新以下测试：

1. 心跳创建的账本行持久化 `heartbeatRunId`、`biller`、`billingType` 和缓存 token
2. 遗留适配器计费值正确映射
3. 提供商报告仅使用账本数据
4. 混合提供商的公司不发生订阅用量的交叉归因
5. 零美元订阅用量仍显示在 token 报告中
6. 配额获取失败渲染明确的 UI 状态
7. 手动 cost 事件仍能正确验证和写入
8. 计费方报告保持上游提供商分解独立
9. OpenRouter 风格的记录能够在非 OpenRouter 上游提供商下显示 `biller=openrouter`
10. Cloudflare 风格的记录能够在保留上游提供商身份的情况下显示 `biller=cloudflare`
11. 未来的 `finance_events` 聚合能够处理无需模型或运行 ID 的非请求费用

## 交付计划

### 第一步

- 落地账本契约和查询重写
- 使当前费用页面数据准确

### 第二步

- 添加以计费方为导向的报告端点和 UI

### 第三步

- 将 OpenRouter 及未来的聚合商适配器接入同一契约

### 第四步

- 如果适配器级分组成为产品需求，则将 `executionAdapterType` 添加到持久化的费用报告中

### 第五步

- 引入 `finance_events`
- 添加非推理会计端点
- 在推理消费和用量旁边添加平台/账户费用的 UI

## 本次变更的非目标

- 多币种支持
- 发票对账
- 超出持久化计费成本范围的提供商特定成本估算
- 替换 `heartbeat_runs` 作为运行操作记录
