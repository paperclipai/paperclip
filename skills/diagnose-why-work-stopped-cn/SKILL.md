---
name: diagnose-why-work-stopped-cn
required: false
description: >
  处理「工作为何停住 / 为何打转」类指派：先对已命名事务树取证， pinpoint 精确停损点，
  把补救框定为尊重三条不变式的通用产品规则（有效工作持续推进、只有真阻塞才停机、不允许无限环路），产出计划但不写代码，
  且须经董事会/CTO批准后才能拆子事务。适用于停滞、打转或深挖过头的事务树法医分析诉求。
---

# Diagnose Why Work Stopped（中文）

针对反复出现的一类工单：人或经理指向一颗停滞 / 打转 / 过度恢复的事务树问「为啥停了 / 为啥循环 / 怎么避免再来」？

本技能偏重**取证 + 产品设计**，不负责落地改代码——交付物是可复核的根因分析与已批准的计划。

正式执行前先读 `doc/execution-semantics.md`，把它视作状态词、可行路径、跑后收口、bounded continuation、效率复盘 vs 活跃度恢复、「暂停占位」静默监控狗等的权威定义。若在调查中出现真实的产品规则空洞，计划中应写明 `doc/execution-semantics.md` 是否需要增补。

## 何时使用

工单标题或正文若匹配下列任一（或贴了具体停滞树链接）：

- 「为啥停了」「为啥卡住」「咋突然不动了」
- 「无限循环」「打转」「太深」「recovery 太深」
- 「从产品设计角度」「通用原则」
- 要求在**任何产品改动前先做法医/复盘**

也包括：用户要求在代码 PR 前先给书面根因的场景。

## 何时不要用

- 指派目标就是交付具体代码补丁 → 走普通工程链路。
- 普通功能 bug 报告 → 普通排查。
- 你是原始作者被要求修自己的 defect → 正常 debug。

## 必须同时满足的三条不变式

产品与规则设计不得破坏（用户已在多个 issue 强调；视为结构件）：

1. **有成效的工作要继续。**能看清下一步的智能体不能因为「没人叫醒」而停住。（例 issue：PAP-2674、PAP-2708）
2. **只有真实的外部阻塞才让停。**缺失审批 / 前置依赖 / 责任人才能停；虚构的静默 `in_review`、错误的 cancel 叶、残缺元数据要能被发现并导流，不允许一声不吭停下。（例：PAP-2335、PAP-2674）
3. **禁止无限回路。**流落工作的恢复链路要有界，不能与「真正有产出的Continuation」混在一起。（例：PAP-2602、PAP-2486）

任一规则若会破坏其中任意一条，删掉或重写，并在计划中逐条自检说明如何守卫。

## 流程

### 0. 先读现行执行语义

Walking the tree **之前**：读透 `doc/execution-semantics.md` 用词：

- active path / waiting path / recovery path
- terminal / explicitly live / explicitly waiting / invalid
- bounded `run_liveness_continuation`
- productivity review vs liveness recovery
- subtree pause hold
- silent active-run watchdog

在能说清与原契约差异之前，不要发明新概念。

### 1. 对指定树的取证——第一步且必须具体

必须在同一 heartbeat；没拿到停损点前不要抛规则提案。

- 打开链接事务（阻塞链、父级、「恢复」兄弟姐妹、近期 run）。
- 逐节点枚举，找到让全局停下来的 **具体 (issue + status)** 组合。公司里已出现的典型形状包括但不限于：
  - `in_review` 但没有 typed reviewer、没有在跑的运行、无任何 pending interaction/recovery：
  - 「成功运行后仍处于 `in_progress` 且无下一跳动作」；
  - 阻塞链叶节点为 `cancelled`/畸形/跨仓不可访问；
  - `issue.continuation_recovery` 在同一事务上短时间反复唤醒超限；
  - Stranded-recovery 把自家 recovery issue 当成再恢复源；
- 附上证据链：run id、评论时间戳、状态迁移。若跨公司边界 API 拿不到直接证据只能说「推论」并标明 provisional。（例：PAP-2631）

### 2. 调研邻近近期工作

在产品规则前要读最近相关 merge/issue。用户口头禅：「看看我们两三天内刚上线的 liveness 相关 PR」。若计划和 48 小时前落地的行为互相打架那是返工而非改进。

简述：我读 X/Y/Z → 发现的真正缺口是什么。

### 3. 对树里每个不进度的节点分类

对所有非 `done`/`cancel`/正在跑的事务：

- **真需要人或董事会**：写出责任人与下一步。
- **本可实现但路由缺失**：要写清「若存在某条契约该如何唤醒谁」。
- **其实已有**：指到具体 run/wake/recovery/interaction。

这是用户反复强调要的「表格」（例 PAP-2335）。

### 4. 把结论表述成契约级规则而非 if/else 补丁

- 句式要是「对所有 X 的统一约束」，而非「这棵树上改一行」。（例契约：任一 agent-own 的非终态心跳结束必须落入终态或显式 wait/live。）
- 再与 `doc/execution-semantics.md` reconcile：优先援引已有条文；只有当文档不完整或与已采纳实现矛盾时才改文档草稿。
- 再次逐条自检三条不变式。

若规则会让你「近期一次成功跑」也变不可能，删掉或收窄。

### 5. 只写计划，不写代码

写进事务的 `plan` 文档：

- 取证小节（根因 + 证据）。
- 通用契约描述。
- 现有 `execution-semantics` 是否已经覆盖 vs 你需要补的具体 diff。
- 分阶段：`Phase 0` 稳妥救活当前树，`Phase 1` 固化文档，`Phase …` detection/recovery/UI/安全/QA/CTO……
- 每阶段写明负责人；优先 specialties（服务端/前端/UX/Security/QA 等）。
- 依赖用 `blockedByIssueIds` 表达；可并行的要写清。

此刻**不许**批量建子工单、不许推送代码。

### 6. 先 request_confirmation，再拆解

对最新 plan revision 开 `request_confirmation`，幂等键：`confirmation:{issueId}:plan:{revisionId}`。等董事会 / CTO Accept。若用户在评论否决旧版 plan，作废旧交互，再以新 revision 重开交互。

批准后：再建分阶段事务 + 阻断链，并让父工单最终 block 在最末 QA / CTO gate，只有链结束才真正唤醒。

### 7. Phase 0 对活体树的止血

无损证据前提下：

- 无 participant 的僵死 `in_review` 叶拉回 `todo` 并写清责任人（参考 PAP-2335）。
- cancelled 占位阻塞链松绑，不要掩耳盗铃把整个树标 `done`。

在原命名 issue comment 写明动了什么——历史链要可查。

### 8. 全部结束后的收口

链路完成后在父工单发 board-facing 总结 comment：修了啥、契约怎么变、如何 rollout（如「重启 CP 载入新字段」）、原树现今状态——然后收尾。

## 常见坑

（略译核心）编码抢在 approval 前面；只吃一条 invariant 牺牲另一条；不写近期 survey；误以为 `in_review` 等于完结；绕过公司 ACL；recovery 递归；悄悄删 symptom issue。

## 发布计划前的自检勾选

- [ ] 已为命名树指明**精确停损点**，并附上 run id / comment id。
- [ ] 已检索并写明近期同源 shipped 工作引用。
- [ ] 已对每个不前进的节点分出「人要介入 / agent 可操作 / 已覆盖」。
- [ ] 规则以**契约**表述，而非一次性补丁话术。
- [ ] 三条不变式逐项写明如何守护。
- [ ] **本 heartbeat 未提交任何代码变更**。
- [ ] `request_confirmation` 已开在**最新 plan revision** 上。
- [ ] Phase 0 描述了如何在不抹证据前提下救活体树。
- [ ] Implementation 段落写清专业分工与 `blockedByIssueIds`。 
