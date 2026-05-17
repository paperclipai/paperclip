---
id: doc-paperclip-human-guide-draft-20260512
status: archived
last_updated: "2026-05-13"
superseded_by: "../03-Paperclip配置与向导/Paperclip人类配置向导.md"
---

# Paperclip 人类配置向导（草案 · 已归档）

> **已归档：** 可操作正文已由 [`../03-Paperclip配置与向导/Paperclip人类配置向导.md`](回形针%20人类配置向导.md) **v1.0**（2026-05-12）完整承接；本文件保留为早期提纲、「写法原则」（§10）及对 process 极简路径讨论的**历史快照**。新读者请直接使用正式向导。

> English subtitle: `Paperclip Human Setup Guide`

## 1. 目标

这份文档不是代码说明，而是给人类看的操作说明书。

它要回答的是：

- 怎么从零创建一家公司
- 怎么把角色配好
- 怎么把 adapter 接上
- 怎么让 agent 跑起来
- 怎么确认它真的稳定
- 怎么从故障里恢复
- 怎么逐步把效率磨上去

## 2. 使用者

这份向导面向三类人：

| 使用者 | 目的 |
| --- | --- |
| 新建者 / First-time setup | 第一次把 Paperclip 跑通 |
| 维护者 / Maintainer | 调整角色、预算、adapter、心跳 |
| 审批者 / Approver | 判断当前公司是否可继续自动运行 |

## 3. 术语对照

下面这些词在本文里保持固定译法，避免前后不一致：

| 中文 | English | 说明 |
| --- | --- | --- |
| 公司 | company | Paperclip 里的组织实体 |
| 角色 | agent / role | 这里优先指固定职责位 |
| 调度 | orchestration | 任务拆分、派单、收单 |
| 适配器 | adapter | 连接具体 CLI 或运行时的执行接口 |
| 心跳 | heartbeat | 周期性唤醒与检查 |
| 收单 | collect / handoff | 完成任务后的结果回收 |
| 归档 | archive | 摘要、索引、证据整理 |
| 恢复 | resume / recovery | 从中断处继续运行 |
| 预算 | budget | 单角色或公司级成本上限 |
| 本地优先 | local-first | 先在本机闭环，再考虑外部化 |

## 4. 当前推荐前提

默认推荐的本地链路是：

- Paperclip 服务跑在 `http://localhost:3100`
- 公司模板从 `公司模板-最小可行公司` 导入
- 本地 worker 通过 `process` adapter 启动
- 需要 issue 上下文时，再用本地 Paperclip API 读取

也就是说，先把公司和 worker 跑在一台机器上，跑顺后再考虑扩展到别的环境。

## 5. 从 0 到 1 的路线图

### 第 1 步：准备环境 / Prepare the environment

- 启动 Paperclip 本地服务
- 确认 `http://localhost:3100/api/health` 可访问
- 确认 `qwen --version` 可运行
- 确认 `codebuddy --version` 可运行
- 确认工作区目录存在
- 确认本机能访问模板目录
- 确认日志目录可写

### 第 2 步：创建公司 / Create the company

- 导入 `C:\Users\wuhen\工具优化\02-智能体-agents\公司模板-最小可行公司\manifest.json`
- 创建公司实例
- 确认公司名为“最小可行公司”或你的实际公司名
- 确认默认预算和角色数正确
- 确认公司导入后没有丢 agent

### 第 3 步：核对 6 个角色 / Verify the six agents

模板里默认应该看到以下角色：

| 角色 | English name | 主要用途 |
| --- | --- | --- |
| CEO / Coordinator | CEO / Coordinator | 负责派单、收单、暂停、恢复 |
| Engineer（后端） | Backend Engineer | 负责后端实现和脚本修复 |
| Frontend Engineer（前端） | Frontend Engineer | 负责页面、交互和样式 |
| Researcher | Researcher | 负责只读探查和资料整理 |
| QA Reviewer | QA Reviewer | 负责验证和回归 |
| Archivist | Archivist | 负责摘要、索引和归档 |

### 第 4 步：确认默认分工 / Confirm default routing

把任务分给对的人，不要让角色互相越界：

- 后端接口、支付、网关、数据库、服务端逻辑 -> `Backend Engineer`
- 前端页面、交互、样式、文案、小中型 UI 改造 -> `Frontend Engineer`
- 复杂问题攻关、跨模块排错、架构取舍 -> `CEO / Coordinator` 或更高审查位
- `typecheck` / `test` / `lint` -> `QA Reviewer`
- 研究、依赖图、上下文搜集 -> `Researcher`
- 结果摘要、索引、知识回填 -> `Archivist`

### 第 5 步：绑定 adapter / Bind adapters

- `CEO / Coordinator` -> `codebuddy_local`
- `Backend Engineer` -> `qwen_local`
- `Frontend Engineer` -> `codebuddy_local`
- `Researcher` -> `qwen_local`
- `QA Reviewer` -> `codebuddy_local`
- `Archivist` -> `codebuddy_local`

### 第 6 步：配置运行策略 / Configure runtime policy

- CEO 10 分钟心跳
- Backend Engineer 5 分钟心跳
- Frontend Engineer 5 分钟心跳
- Researcher 15 分钟心跳
- QA Reviewer 10 分钟心跳
- Archivist 30 分钟心跳
- 先从小预算开始，确认稳定再加
- 先允许最小必要写入，再逐步放开

### 第 7 步：启动第一轮测试 / Run the first test

- 选一个低风险任务
- 让 CEO 先拆任务
- 让对应 worker 执行
- 看 `resultJson.stdout` 是否完整
- 看是否有 issue comment 或回写
- 看失败时是否能恢复

## 6. 稳定运行的判断标准

当第一轮测试过了，接下来要看的是“能不能稳跑”。

| 检查项 | 通过标准 |
| --- | --- |
| 角色是否清楚 | 每个 agent 的职责不互相抢 |
| 任务是否清楚 | 派单有边界，有验收 |
| 收单是否清楚 | result 里能看出完成了什么 |
| 恢复是否清楚 | 失败后知道从哪里继续 |
| 预算是否清楚 | 不会单 agent 把额度耗尽 |
| 风险是否清楚 | 高风险动作能挡住 |
| 证据是否清楚 | 结果可追溯到日志、文件和产物 |

## 7. 人类每天该看什么 / Daily operator checklist

稳定运行后，人类不需要看全部过程，只需要看这些东西：

- 今日在跑哪些公司 / 角色
- 哪些任务完成了
- 哪些任务阻塞了
- 哪些 agent 失败了
- 哪些预算快到上限了
- 哪些动作需要人类确认
- 哪些结果可以归档

## 8. 故障分类 / Failure modes

建议把故障先分成 5 类：

| 故障 | 处理方式 |
| --- | --- |
| 任务定义不清 | 重写任务单 / 重新派单 |
| adapter 不可用 | 切换 adapter / 检查本机环境 |
| 上下文污染 | reset session / 新开 run |
| 预算耗尽 | 暂停该角色 / 等待人工处理 |
| 高风险越界 | 立即拦停，进入人类确认 |

## 9. 从试跑到稳定的磨法

效率不要一开始就追极致，应该按顺序磨：

1. 先把角色固化
2. 再把模板固化
3. 再把恢复做稳
4. 再把收单做准
5. 再把心跳调顺
6. 再把预算调细
7. 最后再优化吞吐和上下文消耗

## 10. 这份向导的写法原则

- 写给人看，也要能让模型照着做
- 不写抽象口号，只写可执行步骤
- 不把规则散在多个文档里
- 不把运行时日志混进操作手册
- 不把猜测写成系统行为

## 11. 后续应该补的章节

后面可以继续补成完整操作手册：

- 创建公司流程
- 公司模板导入流程
- 角色编辑流程
- adapter 安装与切换
- 第一次派单示例
- 查看日志与结果
- 失败恢复流程
- 降级与暂停流程
- 稳态优化流程
