# 2026-03-14 适配器技能同步推出

状态：提议
日期：2026-03-14
受众：产品和工程
相关：
- `doc/plans/2026-03-14-skills-ui-product-plan.md`
- `doc/plans/2026-03-13-company-import-export-v2.md`
- `docs/companies/companies-spec.md`

## 1. 目的

本文档定义了 Paperclip 适配器范围技能支持的推出计划。

目标不仅是"显示一个技能标签页"。目标是：

- 每个适配器有一个明确的技能同步事实模型
- UI 对该适配器如实展示
- 即使适配器无法完全协调，Paperclip 也一致地存储期望技能状态
- 不支持的适配器清晰且安全地降级

## 2. 当前适配器矩阵

Paperclip 当前有以下适配器：

- `claude_local`
- `codex_local`
- `cursor_local`
- `gemini_local`
- `opencode_local`
- `pi_local`
- `openclaw_gateway`

当前技能 API 支持：

- `unsupported`
- `persistent`
- `ephemeral`

当前实现状态：

- `codex_local`：已实现，`persistent`
- `claude_local`：已实现，`ephemeral`
- `cursor_local`：尚未实现，但技术上适合 `persistent`
- `gemini_local`：尚未实现，但技术上适合 `persistent`
- `pi_local`：尚未实现，但技术上适合 `persistent`
- `opencode_local`：尚未实现；可能是 `persistent`，但需要特殊处理，因为它当前注入到 Claude 的共享技能主目录中
- `openclaw_gateway`：尚未实现；因网关协议支持而受阻，当前为 `unsupported`

## 3. 产品原则

1. 期望技能对每个适配器都存储在 Paperclip 中。
2. 适配器可能暴露不同的事实模型，UI 必须如实反映。
3. 持久化适配器应读取并协调实际已安装状态。
4. 临时适配器应报告有效的运行时状态，而不是假装拥有持久安装。
5. 共享主目录的适配器需要比隔离主目录的适配器更强的安全措施。
6. 网关或云适配器不得伪造本地文件系统同步。

## 4. 适配器分类

### 4.1 持久化本地主目录适配器

这些适配器有一个稳定的本地技能目录，Paperclip 可以读取和管理。

候选：

- `codex_local`
- `cursor_local`
- `gemini_local`
- `pi_local`
- `opencode_local`（有注意事项）

预期 UX：

- 显示实际已安装的技能
- 显示受管与外部技能
- 支持 `sync`
- 支持过时移除
- 保留未知的外部技能

### 4.2 临时挂载适配器

这些适配器没有有意义的 Paperclip 拥有的持久安装状态。

当前适配器：

- `claude_local`

预期 UX：

- 显示期望的 Paperclip 技能
- 如果可用，显示任何可发现的外部目录
- 说"下次运行时挂载"而不是"已安装"
- 不暗示适配器拥有的持久安装状态

### 4.3 不支持 / 远程适配器

这些适配器在没有新外部能力的情况下无法支持技能同步。

当前适配器：

- `openclaw_gateway`

预期 UX：

- 公司技能库仍然有效
- 智能体挂载 UI 在期望状态级别仍然有效
- 实际适配器状态为 `unsupported`
- 同步按钮被禁用或替换为解释性文本

## 5. 每适配器计划

### 5.1 Codex Local

目标模式：

- `persistent`

当前状态：

- 已实现

完成所需工作：

- 保持为参考实现
- 加强围绕外部自定义技能和过时移除的测试
- 确保导入的公司技能可以被挂载和同步而无需手动路径操作

成功标准：

- 列出已安装的受管和外部技能
- 将期望技能同步到 `CODEX_HOME/skills`
- 保留外部用户管理的技能

### 5.2 Claude Local

目标模式：

- `ephemeral`

当前状态：

- 已实现

完成所需工作：

- 在 UI 中打磨状态语言
- 清楚区分"期望"和"下次运行时挂载"
- 如果 Claude 暴露了外部技能目录，可选展示

成功标准：

- 期望技能存储在 Paperclip 中
- 选中的技能在每次运行时挂载
- 无误导性的"已安装"语言

### 5.3 Cursor Local

目标模式：

- `persistent`

技术基础：

- 运行时已将 Paperclip 技能注入到 `~/.cursor/skills`

实现工作：

1. 为 Cursor 添加 `listSkills`。
2. 为 Cursor 添加 `syncSkills`。
3. 复用与 Codex 相同的受管符号链接模式。
4. 区分：
   - 受管 Paperclip 技能
   - 已存在的外部技能
   - 缺失的期望技能
   - 过时的受管技能

测试：

- 发现的单元测试
- 同步和过时移除的单元测试
- 验证共享认证/会话设置不受干扰

成功标准：

- Cursor 智能体显示真实已安装状态
- 从智能体技能标签页同步有效

### 5.4 Gemini Local

目标模式：

- `persistent`

技术基础：

- 运行时已将 Paperclip 技能注入到 `~/.gemini/skills`

实现工作：

1. 为 Gemini 添加 `listSkills`。
2. 为 Gemini 添加 `syncSkills`。
3. 复用 Codex/Cursor 的受管符号链接约定。
4. 验证在技能协调时认证保持不受影响。

潜在注意事项：

- 如果 Gemini 将该技能目录视为共享用户状态，UI 应在移除过时受管技能前发出警告

成功标准：

- Gemini 智能体可以协调期望与实际技能状态

### 5.5 Pi Local

目标模式：

- `persistent`

技术基础：

- 运行时已将 Paperclip 技能注入到 `~/.pi/agent/skills`

实现工作：

1. 为 Pi 添加 `listSkills`。
2. 为 Pi 添加 `syncSkills`。
3. 复用受管符号链接辅助工具。
4. 验证会话文件行为与技能同步保持独立。

成功标准：

- Pi 智能体暴露实际已安装技能状态
- Paperclip 可以将期望技能同步到 Pi 的持久主目录

### 5.6 OpenCode Local

目标模式：

- `persistent`

特殊情况：

- OpenCode 当前将 Paperclip 技能注入到 `~/.claude/skills`

这在产品上有风险，因为：

- 它与 Claude 共享状态
- Paperclip 可能在主目录共享的情况下错误地暗示技能仅属于 OpenCode

计划：

第一阶段：

- 实现 `listSkills` 和 `syncSkills`
- 视为 `persistent`
- 在 UI 文案中明确标记主目录为共享
- 仅移除明确标记为 Paperclip 管理的过时受管技能

第二阶段：

- 调查 OpenCode 是否支持自己的隔离技能主目录
- 如果是，迁移到适配器特定的主目录并移除共享主目录的注意事项

成功标准：

- OpenCode 智能体显示真实状态
- 共享主目录风险可见且有界

### 5.7 OpenClaw Gateway

目标模式：

- 在网关协议支持存在之前为 `unsupported`

需要的外部工作：

- 列出已安装/可用技能的网关 API
- 安装/移除或以其他方式协调技能的网关 API
- 状态是持久还是临时的网关元数据

在此之前：

- Paperclip 仅存储期望技能
- UI 显示不支持的实际状态
- 无伪造的同步实现

未来目标：

- 可能最终有第四种事实模型，如远程管理的持久状态
- 目前保持当前 API 并将网关视为不支持

## 6. API 计划

## 6.1 保持当前最小适配器 API

近期适配器合约保持：

- `listSkills(ctx)`
- `syncSkills(ctx, desiredSkills)`

这对所有本地适配器足够。

## 6.2 可选扩展点

仅在首次广泛推出后需要时添加：

- `skillHomeLabel`
- `sharedHome: boolean`
- `supportsExternalDiscovery: boolean`
- `supportsDestructiveSync: boolean`

这些应是快照的可选元数据补充，而非必需的新适配器方法。

## 7. UI 计划

公司级别的技能库可以保持适配器无关。

智能体级别的技能标签页必须通过文案和状态变得适配器感知：

- `persistent`：已安装 / 缺失 / 过时 / 外部
- `ephemeral`：下次运行时挂载 / 外部 / 仅期望
- `unsupported`：仅期望，适配器无法报告实际状态

共享主目录适配器的额外 UI 要求：

- 显示适配器使用共享用户技能主目录的小警告
- 除非 Paperclip 能证明技能是 Paperclip 管理的，否则避免破坏性措辞

## 8. 推出阶段

### 第一阶段：完成本地文件系统家族

发布：

- `cursor_local`
- `gemini_local`
- `pi_local`

理由：

- 这些在架构上与 Codex 最接近
- 它们已注入到稳定的本地技能主目录

### 第二阶段：OpenCode 共享主目录支持

发布：

- `opencode_local`

理由：

- 技术上现在可行
- 由于共享的 Claude 技能主目录，需要稍微更谨慎的产品语言

### 第三阶段：网关支持决策

决定：

- V1 保持 `openclaw_gateway` 不支持
- 或扩展网关协议用于远程技能管理

我的建议：

- 不要因网关支持而阻塞 V1
- 在远程协议存在之前保持明确不支持

## 9. 完成定义

适配器范围的技能支持在以下全部为真时就绪：

1. 每个适配器有明确的事实模型：
   - `persistent`
   - `ephemeral`
   - `unsupported`
2. UI 文案与该事实模型匹配。
3. 所有本地持久化适配器实现了：
   - `listSkills`
   - `syncSkills`
4. 测试覆盖：
   - 期望状态存储
   - 实际状态发现
   - 受管与外部区分
   - 支持的情况下过时受管技能清理
5. `openclaw_gateway` 要么：
   - 明确不支持且 UX 干净
   - 要么由真实的远程技能 API 支持

## 10. 建议

推荐的立即顺序是：

1. `cursor_local`
2. `gemini_local`
3. `pi_local`
4. `opencode_local`
5. 推迟 `openclaw_gateway`

这使 Paperclip 从"技能适用于 Codex 和 Claude"发展到"技能适用于整个本地适配器家族"，这是有意义的 V1 里程碑。
