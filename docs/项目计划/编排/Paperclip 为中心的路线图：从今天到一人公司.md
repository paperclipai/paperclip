# Paperclip 为中心的路线图：从今天到一人公司

## 你现在的位置

```
世界上的AI使用者：├── 99% 人：用单个AI聊天├── 0.9% 人：用单个CLI做开发├── 0.09% 人：用Paperclip编排多个Agent├── 0.009% 人：有完整的编排方法论 + 四仓架构└── 你在这里：方法论 ✓ 架构 ✓ 正在落地目标：成为编排者。成为之后比的是「谁的token更产生价值」。
```

|要素|你已有的|还需要|
|---|---|---|
|**跑起来**|Paperclip已装|配完Routic蜂群模板，跑通第一个闭环|
|**被看见**|项目已上线|一个能对外展示的东西：文章/视频/开源模板|
|**可复制**|方法论文档已完成|别人能30分钟内复现你的核心体验|

---

## 两个月路线图（不是之前的四阶段了）

第1周：闭环——不让它做多，让它做对
Paperclip配Routic蜂群模板（用你文档§7的定义）
只跑1个Agent：Token Engineer
给它一个真实的小任务：改一个配置文件、修一个小bug
它在预发机跑 → 自动验证 → 你验收
这个闭环通了，后面只是量变

第2周：多Agent协作
证明蜂群不是单兵，加CEO + QA Reviewer
CEO拆任务 → Engineer实现 → QA验证 → 你验收
记录：你每天花多少时间？产出对比之前怎么样？

第3-4周：外部感知
证明Agent不是盲的
接业务数据、错误监控、用户反馈
CEO能根据数据调整策略
记录下来：Agent做过哪些「你不在时它自己判断正确」的事情

第5-8周：打磨成可展示的东西
录一段视频：一个需求从issue到预发验证通过，你只点了3次鼠标├── 
写一篇文章：方法论 + 实测数据 + 模板开源
如果你要商业化：把汉化、千问/火山/百炼适配器作为差异化

## 你独有的差异点
市面上99%的Paperclip教程是英文的，适配的是Claude/Codex/Cursor。你的差异：
别人：英文界面 + Claude/Codex + 英文教程你：中文界面 + 千问/火山/百炼适配 + 中文方法论 + 国内市场别人：演示demo项目你：有真实上线项目做验证别人：消耗token做benchmark你：消耗token产生产品价
如果这套东西能卖，卖的不是技术——Paperclip是MIT开源的。卖的是**「在中国用中国模型跑AI公司」的Know-how**：

- 火山/百炼的适配器怎么写
- 中文环境下的Agent角色定义有什么区别
- 国内Slack/飞书/企业微信的MCP连接器
- 合规、备案、敏感词——这些海外教程完全不覆盖




## 先确认我们达成的共识

![*.txt](https://registry.npmmirror.com/@lobehub/assets-fileicon/1.0.0/files/assets/document.svg)

Plaintext

```
✅ Paperclip 做核心编排底座（不重写）✅ 外部 CLI 自带的推理/工具/函数能力不碰✅ 从其他项目吸收的是「模式」，不是「框架集成」✅ 数据有序开放 + 权限分级扩展✅ 薄调度层：几百行代码，不是几万行✅ 先单机跑满，再考虑扩展✅ 联邦架构是愿景方向，不是起步动作
```

---

## 路线图：四个阶段

![*.txt](https://registry.npmmirror.com/@lobehub/assets-fileicon/1.0.0/files/assets/document.svg)

Plaintext

```
阶段1 ────→ 阶段2 ────→ 阶段3 ────→ 阶段4让它在跑     让它能感知    让它能伸手    让它能扩展(本周)       (2周内)      (1个月内)    (按需)
```

---

### 阶段1：让它在跑

**目标：** 单机Paperclip从「能启动」到「能产出」

**具体动作：**

![*.txt](https://registry.npmmirror.com/@lobehub/assets-fileicon/1.0.0/files/assets/document.svg)

Plaintext

```
□ 装Paperclip，跑通npx paperclipai onboard□ 配3-5个Agent（不是10个）：   ├── CEO (Claude Opus/Sonnet)   ├── 开发者 (Claude Code)   ├── 测试者 (Claude Code + Janitor模式)   └── 你实际业务最需要的1-2个角色□ 给每个Agent写清楚的system prompt□ 设一个真实的小目标，让它跑完□ 看产出质量，调prompt，再跑
```

**验证标准：**

- Agent 能完成一个端到端的小任务
- 你不需要每5分钟介入
- 产出的东西可以用（哪怕需要你改）

**不做什么：**

- ❌ 不改Paperclip代码
- ❌ 不加任何外部集成
- ❌ 不搞多台机器

---

### 阶段2：让它能感知

**触发条件：** Agent 能稳定产出，但经常「不知道上下文」

**具体动作：**

![*.txt](https://registry.npmmirror.com/@lobehub/assets-fileicon/1.0.0/files/assets/document.svg)

Plaintext

```
□ 建 .paperclip/state/ 目录□ 写3个MCP工具（只读）：   ├── getKeyMetrics() → 从业务数据源拉指标   ├── getAppHealth() → 从Sentry/监控拉错误率   └── getUserFeedback() → 从客服渠道拉最近反馈□ 加入 pre-heartbeat hook，生成本地dashboard.md□ 修改CEO Agent的system prompt：第一步读dashboard□ 让Agent在工单里写「我的分析和决策依据」
```

**验证标准：**

- CEO Agent 能根据数据主动调整策略
- 它的分析是有道理的（不是幻觉）
- 你不需要手动告诉它「最近转化率下降了」

**吸收的外部思想：**

- Paperclip 心跳 + 数据感知 = 公司感知系统
- MCP 做能力封装（不直接暴露API Key）

**不做什么：**

- ❌ 不让Agent发邮件/发消息
- ❌ 不让Agent改数据
- ❌ 不接入实时数据流（dashboard.md 心跳时刷新就够了）

---

### 阶段3：让它能伸手

**触发条件：** Agent 能准确判断「需要做什么」，但卡在「做不到」

**具体动作：**

![*.txt](https://registry.npmmirror.com/@lobehub/assets-fileicon/1.0.0/files/assets/document.svg)

Plaintext

```
□ Level 1: 只读外部渠道   ├── 读邮件收件箱   ├── 读飞书/企业微信消息   └── 读客户支持工单□ Level 2: 内部写入   ├── 给自己发飞书通知（关键事件推送）   └── 创建内部文档□ Level 3: 草稿生成（审批后发送）   ├── Agent写邮件回复草稿 → 你审批 → 发送   └── Agent写营销内容草稿 → 你审批 → 发布□ Level 4: 自动化操作（看情况决定要不要开）   └── 高重复低风险的操作自动执行
```

**验证标准：**

- 审批队列每天不超过3-5条（不过载）
- Agent生成的草稿你需要改的部分<20%
- 你每天花在审批上的时间<15分钟

**吸收的外部思想：**

- 权限分级矩阵（不是全开也不是全关）
- MCP 扩展能力层（新增飞书/Slack/邮件连接器）
- 审计日志（所有外部操作可追溯）

**不做什么：**

- ❌ Level 4 不急着开
- ❌ 批量操作需要双重审批
- ❌ 客户付款/退款操作不接

---

### 阶段4：让它能扩展

**触发条件：** 以下之一真实发生

![*.txt](https://registry.npmmirror.com/@lobehub/assets-fileicon/1.0.0/files/assets/document.svg)

Plaintext

```
□ 单机10个Agent确实跑满了，有任务在排队□ 一个Pro账号的配额确实不够用（不是觉得不够，是实际不够）□ 需要不同机器跑不同类型的负载  （比如一台跑GPU推理，一台跑浏览器自动化）
```

**到了这时候怎么做：**

![*.txt](https://registry.npmmirror.com/@lobehub/assets-fileicon/1.0.0/files/assets/document.svg)

Plaintext

```
场景A：配额不够 → 一台机器多账号   └── 同一台机器跑2-3个Paperclip实例，不同端口，不同Pro账号场景B：负载类型不同 → 分机器   └── 机器1跑研发（高token），机器2跑内容（高频率）   └── 顶层脚本只做轻量协调场景C：真的需要联邦 → 到这一步你已经知道真实瓶颈了   └── 那时候的设计会基于实际经验，不是基于想象
```

---

## 🎯 这条路线图的逻辑

![*.txt](https://registry.npmmirror.com/@lobehub/assets-fileicon/1.0.0/files/assets/document.svg)

Plaintext

```
每个阶段只解决「当前真实存在的瓶颈」：阶段1 瓶颈：Agent根本没在跑阶段2 瓶颈：Agent跑起来了但盲目阶段3 瓶颈：Agent知道要做什么但做不到阶段4 瓶颈：单机/单账号确实不够了不解决「想象中的瓶颈」。
```

---

## 📐 几个设计原则（沿途不变）

这些是从我们讨论里提炼出来的，贯穿四个阶段：

![*.txt](https://registry.npmmirror.com/@lobehub/assets-fileicon/1.0.0/files/assets/document.svg)

Plaintext

```
1. 不碰Agent的脑子   CLI自带的推理/工具/函数 → 原封不动   我们只管它「看什么数据」和「做什么外部操作」2. 能力开放 = 权限限制   每接入一个外部渠道，同时定义：   - 哪些Agent能用   - 只读还是读写   - 要不要审批   - 出错了怎么追溯3. 先做感知，后做动作   先让Agent看到数据   验证它的判断是对的   再让它执行4. 复杂度的代价必须有收益   每增加一层抽象，必须回答：   「不用这层会死吗？」
```

---

> 💡 **一句话：路线图的核心不是「什么时候做到100个Agent」，而是「每一步都解决一个你现在确实遇到的真问题」。联邦架构、10台机器、多部门协作——这些是方向，不是计划。今天的唯一动作是把第一台机器的Paperclip跑起来并且产出东西。**


阶段1：启动「Routic 本地蜂群」模板├── 直接用文档 §7 的 Agent 角色定义├── 3-5个Agent（不贪多）├── 默认预算为0或极低├── 跑通一个真实小任务└── 验证：Agent能完成端到端工作，产出可用阶段1.5：Jarvis 读 Paperclip 摘要 ← 新增├── 实现文档 §8 的最小摘要对象├── Jarvis 只读 summary/状态/成本/下一步/source指针├── 不读完整 run log└── 验证：Jarvis 能知道 Paperclip 里发生了什么阶段2：数据感知├── 3个MCP只读工具（业务指标/产品健康/用户反馈）├── pre-heartbeat hook 生成 dashboard.md├── 遵守 Agent 读写权限边界（文档 §7）└── 验证：Agent判断有数据依据阶段3：权限扩展├── 按文档 §7 的「禁止」列反向定义权限├── Level 1-4 分级开放├── 高风险操作 → Human Handoff└── 验证：审批不过载阶段4：按需扩展├── 等单机跑满再说└── 以文档 §5 的冲突裁决规则为准