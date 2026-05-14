---
name: para-memory-files
required: false
description: >
  基于 Tiago Forte PARA 法的文件型记忆系统。在需要跨会话存储、检索、更新或组织知识时使用。
  覆盖三层：（1）PARA 目录下的原子化 YAML 事实知识图谱；（2）按日原始时间线笔记；（3）关于用户习惯的默会知识。
  也涵盖规划文件、记忆衰减、周度汇总与通过 qmd 召回。触发词：保存事实、写日记、创建实体、周度汇总、召回历史上下文、管理计划等。
---

**中文名：** 用 PARA 法的「文件夹+笔记」做长期记忆（知识图谱 / 日记 / 你的习惯）  
**系统 id：** `para-memory-files`（PARA = Projects/Areas/Resources/Archives 四类归档思路）

# PARA 文件型记忆

持久、基于 Tiago Forte PARA 法的文件型记忆：**知识图谱（PARA）、每日原始笔记、对用户自身的默会知识**。路径均相对 `$AGENT_HOME`。

## 三层记忆结构

### 第一层：知识图谱（`$AGENT_HOME/life/` — PARA）

以实体为中心。每个实体一个文件夹，内有两层：

1. `summary.md` —— 秒懂摘要，优先加载。
2. `items.yaml` —— 原子事实，按需加载。

```text
$AGENT_HOME/life/
  projects/          # 有明确目标/截止的在办工作
    <name>/
      summary.md
      items.yaml
  areas/             # 无结束日的持续责任（人/公司）
    people/<name>/
    companies/<name>/
  resources/         # 参考资料与兴趣主题
    <topic>/
  archives/          # 从上面三类归档的非活跃项
  index.md
```

**PARA 规则：**

- **项目（Projects）：** 有目标或时效的在办事项；完结后归入 `archives`。
- **领域（Areas）：** 长期持续（人脉、职务、公司等），无截止日期。
- **资源（Resources）：** 资料与主题。
- **归档（Archives）：** 其他三类迁入的非活跃项。

**事实规则：**

- 耐久事实应立即写入 `items.yaml`。
- 每周依据活跃事实重写 `summary.md`。
- 不要删除事实——用废止链替代（`status: superseded`，填 `superseded_by`）。
- 实体不再活跃时，整夹移到 `$AGENT_HOME/life/archives/`。

**何时新建实体文件夹：**

- 被提及 **≥3** 次，或
- 与用户有直接私人/职业关系（家人、同事、伙伴、客户等），或
- 用户人生中的重点项目/公司；
- 否则先记在每日笔记里。

原子事实 YAML schema 与衰减规则见 [references/schemas.md](references/schemas.md)。

### 第二层：每日笔记（`$AGENT_HOME/memory/YYYY-MM-DD.md`）

事件原始时间线 —— 「何时发生什么」的一层。

- 对话过程中持续写入。
- 在心跳中把耐久事实抽到第一层。

### 第三层：默会知识（`$AGENT_HOME/MEMORY.md`）

用户**如何协作**的模式、偏好、教训。

- 不是关于外部世界的百科全书式事实；而是关于用户自己的行为习惯。
- 学到新模式时就更新。

## 写下来——别靠短时记忆

记忆无法随会话重启自动保留；文件可以。

- 想留住什么 → **写文件**。
- 「记住这个」→ 更新 `$AGENT_HOME/memory/YYYY-MM-DD.md` 或相关实体文件。
- 学到教训 → 更新 AGENTS.md、TOOLS.md 或相关技能文件。
- 踩坑 → 记录下来让未来的你不重蹈覆辙。
- 磁盘上的明文永远优于仅存于上下文的碎碎念。

## 召回——用 qmd

优先用 `qmd`，少用裸 grep：

```bash
qmd query "圣诞节前后发生了什么"   # 语义 + 重排序
qmd search "精确短语"              # BM25 关键字
qmd vsearch "概念性问题"           # 纯向量相似
```

为个人目录建索引：`qmd index $AGENT_HOME`

向量检索 + BM25 + 重排序在措辞不同时仍能找到相关内容。

## 规划

把时间戳版本规划放在仓库根目录的 `plans/`（在个人记忆外侧，便于其他智能体共用计划）。用 `qmd` 检索计划文件。规划会陈旧——若有更新计划，不要被旧版本误导；发现过期就在文件中标明后继关系（例如字段 `supersededBy`）。
