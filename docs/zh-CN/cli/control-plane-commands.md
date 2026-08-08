---
title: 控制平面命令 (Control-Plane Commands)
summary: 包含管理任务 (Issue)、智能体 (Agent)、审批单 (Approval) 及 Dashboard 这几类命令
---

这里用于涵盖各类客户端用于控制及管理平台内部各项事务数据的核心命令行指令。

## 问题追踪任务相关命令 (Issue Commands)

```sh
# 枚举并过滤当前所有的 Issues
pnpm paperclipai issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# 获取且查看某一条指定的具体 Issue 的详情信息
pnpm paperclipai issue get <issue-id-or-identifier>

# 手动打通上报创立一条全新的 Issue 任务
pnpm paperclipai issue create --title "..." [--description "..."] [--status todo] [--priority high]

# 随时强制覆写与修改 Issue 指定属性 (如强行将正在报错的改成进行中阶段)
pnpm paperclipai issue update <issue-id> [--status in_progress] [--comment "..."]

# 如果临时有什么需求补充说明，可以通过添加回复形式备注在某条 Issue 底端评论区
pnpm paperclipai issue comment <issue-id> --body "..." [--reopen]

# 以防万一某些意外中止等，可以通过强制剥夺或代领形式签出某项特定任务挂名在指定干事头上
pnpm paperclipai issue checkout <issue-id> --agent-id <agent-id>

# 主动放权并把原指派在己方头上的特定工作项的所有权进行无责任退回并释放掉
pnpm paperclipai issue release <issue-id>
```

## 部门/公司建制管理命令 (Company Commands)

```sh
pnpm paperclipai company list
pnpm paperclipai company get <company-id>

# 可以像倒出系统备份一样（导出包里面也连带生成并写入了一份便于可读的 manifest 和 markdown 文档材料）将目前系统上整个的建制数据离线倒出变成一套独立的便携压缩文件包
pnpm paperclipai company export <company-id> --out ./exports/acme --include company,agents

# 一键读取并预演预估在正式导入新打包好后系统的最终会呈现的样貌结构（纯预览，不对后台原数据库造成为任何真实不可逆的实质落盘修改）
pnpm paperclipai company import \
  --from https://github.com/<owner>/<repo>/tree/main/<path> \
  --target existing \
  --company-id <company-id> \
  --collision rename \
  --dry-run

# 一键对原系统应用真实有效的最终环境变基操作来接盘导入
pnpm paperclipai company import \
  --from ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## 智能体管理命令 (Agent Commands)

```sh
pnpm paperclipai agent list
pnpm paperclipai agent get <agent-id>
```

## 特批流程类命令集 (Approval Commands)

```sh
# 列出当前全局下各级别各种状态待办处理中的所有特批请示记录流水单
pnpm paperclipai approval list [--status pending]

# 当场取出现场某一单请求请示详情查验来核实确认缘由和正当性
pnpm paperclipai approval get <approval-id>

# 作为系统外“造物主的你”在终端侧人工手动录入下发强派要求
pnpm paperclipai approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# 无条件大开绿灯予以盖章放行该次请示操作（并可以在事中可选录入并追记补充一两句批准的缘由记录）
pnpm paperclipai approval approve <approval-id> [--decision-note "..."]

# 予以否决并直接强硬拒签直接掐断该请示后后续可能的所有衍伸动作
pnpm paperclipai approval reject <approval-id> [--decision-note "..."]

# 一键发回打回重新限期并明示附带了要求勒令其重整上呈修改意见书单重提
pnpm paperclipai approval request-revision <approval-id> [--decision-note "..."]

# 回应并重新回填那些曾被上峰主管打回修正完善过的该项原重申述审批单请示
pnpm paperclipai approval resubmit <approval-id> [--payload '{"..."}']

# 纯属对于下级所提的审批存在些许口头询问或者临时补充指示讨论交流（只打嘴仗，不改变该单的底层实际运行属性和走向流程）
pnpm paperclipai approval comment <approval-id> --body "..."
```

## 审计日志流追查类命令集 (Activity Commands)

```sh
# 对历史产生的一切各种异或常规操作的任何微光留痕做追溯提取
pnpm paperclipai activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## 健康与数据指示面板 (Dashboard)

```sh
# 在命令行窗口一次性直接铺开展现那些目前还在池子里翻腾最热最新或者异常告警中的各项运转关键指标概要详情视图
pnpm paperclipai dashboard get
```

## 脉搏与心跳重制唤醒指令 (Heartbeat)

```sh
# 彻底通过后场强迫唤醒触发对指定智能体一次强制启动执行一轮完整的逻辑生命周转运行周期
pnpm paperclipai heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
