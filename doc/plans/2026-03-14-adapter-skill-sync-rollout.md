# 2026-03-14 适配器技能同步上线计划

状态：提议中
日期：2026-03-14
受众：产品和工程团队
相关文档：
- `doc/plans/2026-03-14-skills-ui-product-plan.md`
- `doc/plans/2026-03-13-company-import-export-v2.md`
- `docs/companies/companies-spec.md`

## 1. 目的

本文档定义了 Paperclip 全适配器技能支持的上线计划。

目标不仅仅是"显示一个技能标签页"。真正的目标是：

- 每个适配器都有一个经过深思熟虑的技能同步真相模型
- UI 如实反映该适配器的状态
- 即使适配器无法完全协调，Paperclip 也能一致地存储期望的技能状态
- 不受支持的适配器能够清晰、安全地降级

## 2. 当前适配器矩阵

Paperclip 目前拥有以下适配器：

- `claude_local`
- `codex_local`
- `cursor_local`
- `gemini_local`
- `opencode_local`
- `pi_local`
- `openclaw_gateway`

当前技能 API 支持的模式：

- `unsupported`
- `persistent`
- `ephemeral`

当前实现状态：

- `codex_local`：已实现，`persistent`
- `claude_local`：已实现，`ephemeral`
- `cursor_local`：尚未实现，但技术上适合 `persistent`
- `gemini_local`：尚未实现，但技术上适合 `persistent`
- `pi_local`：尚未实现，但技术上适合 `persistent`
- `opencode_local`：尚未实现；可能适合 `persistent`，但需要特殊处理，因为它目前注入到 Claude 的共享技能主目录中
- `openclaw_gateway`：尚未实现；受网关协议支持阻塞，暂时为 `unsupported`

## 3. 产品原则

1. 期望的技能对每个适配器都存储在 Paperclip 中。
2. 适配器可能暴露不同的真相模型，UI 必须如实反映。
3. 持久化适配器应该读取并协调实际安装状态。
4. 临时适配器应该报告有效的运行时状态，而不是假装拥有持久化安装。
5. 共享主目录的适配器比隔离主目录的适配器需要更强的安全措施。
6. 网关或云适配器不得伪造本地文件系统同步。

## 4. 适配器分类

### 4.1 持久化本地主目录适配器

这些适配器具有稳定的本地技能目录，Paperclip 可以读取和管理。

候选适配器：

- `codex_local`
- `cursor_local`
- `gemini_local`
- `pi_local`
- `opencode_local`（有注意事项）

预期用户体验：

- 显示实际已安装的技能
- 显示受管理与外部技能
- 支持 `sync`（同步）
- 支持清除过期技能
- 保留未知的外部技能

### 4.2 临时挂载适配器

这些适配器没有由 Paperclip 拥有的有意义的持久化安装状态。

当前适配器：

- `claude_local`

预期用户体验：

- 显示 Paperclip 期望的技能
- 如果可用，显示可发现的外部目录
- 显示"下次运行时挂载"而非"已安装"
- 不暗示存在由适配器拥有的持久化安装状态

### 4.3 不支持/远程适配器

这些适配器在没有新的外部能力的情况下无法支持技能同步。

当前适配器：

- `openclaw_gateway`

预期用户体验：

- 公司技能库仍然可用
- 代理附加 UI 仍然在期望状态层面工作
- 实际适配器状态为 `unsupported`
- 同步按钮被禁用或替换为说明文字

## 5. 各适配器计划

### 5.1 Codex Local

目标模式：

- `persistent`

当前状态：

- 已实现

完成所需工作：

- 保持作为参考实现
- 加强外部自定义技能和过期清除的测试
- 确保导入的公司技能可以被附加和同步，无需手动路径操作

成功标准：

- 列出已安装的受管理和外部技能
- 将期望的技能同步到 `CODEX_HOME/skills`
- 保留外部用户管理的技能

### 5.2 Claude Local

目标模式：

- `ephemeral`

当前状态：

- 已实现

完成所需工作：

- 优化 UI 中的状态语言
- 清晰区分"期望"和"下次运行时挂载"
- 可选地展示已配置的外部技能目录（如果 Claude 公开了这些信息）

成功标准：

- 期望的技能存储在 Paperclip 中
- 选中的技能按次运行时挂载
- 没有误导性的"已安装"用语

### 5.3 Cursor Local

目标模式：

- `persistent`

技术基础：

- 运行时已将 Paperclip 技能注入到 `~/.cursor/skills`

实现工作：

1. 为 Cursor 添加 `listSkills`。
2. 为 Cursor 添加 `syncSkills`。
3. 复用与 Codex 相同的受管理符号链接模式。
4. 区分：
   - 受管理的 Paperclip 技能
   - 已存在的外部技能
   - 缺失的期望技能
   - 过期的受管理技能

测试：

- 发现功能的单元测试
- 同步和过期清除的单元测试
- 验证共享的认证/会话设置不受干扰

成功标准：

- Cursor 代理显示真实的安装状态
- 从代理技能标签页进行同步可以正常工作

### 5.4 Gemini Local

目标模式：

- `persistent`

技术基础：

- 运行时已将 Paperclip 技能注入到 `~/.gemini/skills`

实现工作：

1. 为 Gemini 添加 `listSkills`。
2. 为 Gemini 添加 `syncSkills`。
3. 复用 Codex/Cursor 的受管理符号链接约定。
4. 验证在协调技能时认证保持不变。

潜在注意事项：

- 如果 Gemini 将该技能目录视为共享用户状态，UI 应在删除过期受管理技能前发出警告

成功标准：

- Gemini 代理可以协调期望状态与实际技能状态

### 5.5 Pi Local

目标模式：

- `persistent`

技术基础：

- 运行时已将 Paperclip 技能注入到 `~/.pi/agent/skills`

实现工作：

1. 为 Pi 添加 `listSkills`。
2. 为 Pi 添加 `syncSkills`。
3. 复用受管理符号链接辅助工具。
4. 验证会话文件行为与技能同步保持独立。

成功标准：

- Pi 代理暴露实际已安装的技能状态
- Paperclip 可以将期望的技能同步到 Pi 的持久化主目录

### 5.6 OpenCode Local

目标模式：

- `persistent`

特殊情况：

- OpenCode 目前将 Paperclip 技能注入到 `~/.claude/skills`

这在产品层面存在风险，因为：

- 它与 Claude 共享状态
- 当主目录是共享的时，Paperclip 可能会意外暗示这些技能仅属于 OpenCode

计划：

第一阶段：

- 实现 `listSkills` 和 `syncSkills`
- 将其视为 `persistent`
- 在 UI 文案中明确标注该主目录为共享
- 仅删除明确标记为 Paperclip 管理的过期受管理技能

第二阶段：

- 调查 OpenCode 是否支持其自己的隔离技能主目录
- 如果支持，迁移到适配器专属主目录并消除共享主目录的注意事项

成功标准：

- OpenCode 代理显示真实状态
- 共享主目录风险可见且受控

### 5.7 OpenClaw Gateway

目标模式：

- 在网关协议支持可用之前为 `unsupported`

所需的外部工作：

- 列出已安装/可用技能的网关 API
- 安装/删除或以其他方式协调技能的网关 API
- 状态是持久化还是临时的网关元数据

在此之前：

- Paperclip 仅存储期望的技能
- UI 显示不支持的实际状态
- 不提供伪造的同步实现

未来目标：

- 最终可能出现第四种真相模型，例如远程管理的持久化状态
- 目前保持当前 API，将网关视为不支持

## 6. API 计划

## 6.1 保持当前最小化的适配器 API

近期适配器契约保持不变：

- `listSkills(ctx)`
- `syncSkills(ctx, desiredSkills)`

这对所有本地适配器已经足够。

## 6.2 可选扩展点

仅在首次广泛上线后根据需要添加：

- `skillHomeLabel`
- `sharedHome: boolean`
- `supportsExternalDiscovery: boolean`
- `supportsDestructiveSync: boolean`

这些应该是快照的可选元数据补充，而不是必需的新适配器方法。

## 7. UI 计划

公司级技能库可以保持适配器无关。

代理级技能标签页必须通过文案和状态变得适配器感知：

- `persistent`：已安装 / 缺失 / 过期 / 外部
- `ephemeral`：下次运行时挂载 / 外部 / 仅期望
- `unsupported`：仅期望，适配器无法报告实际状态

共享主目录适配器的额外 UI 要求：

- 显示一个小警告，说明该适配器使用共享的用户技能主目录
- 除非 Paperclip 能证明某个技能是 Paperclip 管理的，否则避免使用破坏性措辞

## 8. 上线阶段

### 第一阶段：完成本地文件系统家族

发布：

- `cursor_local`
- `gemini_local`
- `pi_local`

理由：

- 这些在架构上最接近 Codex
- 它们已经注入到稳定的本地技能主目录

### 第二阶段：OpenCode 共享主目录支持

发布：

- `opencode_local`

理由：

- 技术上现在就可以实现
- 由于共享 Claude 技能主目录，需要稍微更谨慎的产品用语

### 第三阶段：网关支持决策

决定：

- V1 保持 `openclaw_gateway` 不支持
- 或扩展网关协议以支持远程技能管理

我的建议：

- 不要因为网关支持而阻塞 V1
- 在远程协议存在之前明确保持不支持状态

## 9. 完成定义

全适配器技能支持在以下条件全部满足时视为就绪：

1. 每个适配器都有明确的真相模型：
   - `persistent`
   - `ephemeral`
   - `unsupported`
2. UI 文案与该真相模型匹配。
3. 所有本地持久化适配器都实现了：
   - `listSkills`
   - `syncSkills`
4. 测试覆盖：
   - 期望状态存储
   - 实际状态发现
   - 受管理与外部的区分
   - 支持的场景下的过期受管理技能清理
5. `openclaw_gateway` 要么：
   - 明确不支持并具有清晰的用户体验
   - 要么由真实的远程技能 API 支撑

## 10. 建议

推荐的即时执行顺序为：

1. `cursor_local`
2. `gemini_local`
3. `pi_local`
4. `opencode_local`
5. 推迟 `openclaw_gateway`

这将使 Paperclip 从"技能仅对 Codex 和 Claude 有效"升级到"技能对整个本地适配器家族有效"，这才是有意义的 V1 里程碑。
