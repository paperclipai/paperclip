# 实践：Board 界面中文口径与文档对照表

**状态：** 现行真值（写执行单、探查、助手说明时 **必须先查本表**）  
**真源文件：** [`ui/src/lib/i18n.ts`](../../../ui/src/lib/i18n.ts)（`nav`、`orchestrationInjectionPage`、`issueDetailUi`、`runLedger` 等）  
**路由真源：** [`ui/src/App.tsx`](../../../ui/src/App.tsx)、[`ui/src/components/Sidebar.tsx`](../../../ui/src/components/Sidebar.tsx)

**返回：** [最佳实践 README](README.md) · 与 [011 看板汉化流程](011-实践-回形针UI页面汉化流程.md) 互补（011 讲怎么改字；本表讲 **叫什么**）

---

## 1. 为何会写错（根源）

| 来源 | 问题 |
| --- | --- |
| 早期讨论 / 代码注释 | 用「编排注入」指 `OrchestrationInjection` 页面（按 **功能** 起名） |
| 2026-05 前后 UI 汉化 | 侧边栏已改为 **「运行清单」**（`nav.orchestrationInjection`），文档未批量跟进 |
| 执行单母本 **24 §E** | 用 **E1/E2** 分段编号；对人说明步骤时易再发明一套说法，与 Board 不一致 |
| 助手 / 文档作者 | 照旧文档写「工作 → 编排注入」，而 **「工作」只是分组标题**，不是页面名 |

**规则：** 对用户说的路径 = **侧边栏上看得见的中文**；括号里可附路由或英文组件名供开发查代码。

---

## 2. 侧边栏（`nav` + `Sidebar.tsx`）

| 界面上看到的 | 不是 | 路由（公司前缀后） | i18n 键 |
| --- | --- | --- | --- |
| **工作台** | — | `/dashboard` | `nav.dashboard` |
| **收件箱** | — | `/inbox` | `nav.inbox` |
| **工作**（分组标题，**不是页面**） | 某个菜单项 | — | `nav.work` |
| ↳ **事务清单** | — | `/issues` | `nav.issues` |
| ↳ **例行任务** | — | `/routines` | `nav.routines` |
| ↳ **心跳任务** | — | `/heartbeat-tasks` | `nav.heartbeatTasks` |
| ↳ **运行清单** | ~~编排注入~~、编排注入页 | **`/runs`**（详情 **`/runs/{runId}`**） | `nav.orchestrationInjection`（键名待随代码重命名） |
| ↳ **编排闸门** | — | `/orchestration-gates` | `nav.orchestrationGates` |
| ↳ **公司目标** | — | `/goals` | `nav.goals` |
| ↳ **工作区** | — | `/workspaces` | `nav.workspaces` |
| **成本** | — | `/costs` | `nav.costs` |
| **活动** | — | `/activity` | `nav.activity` |

**正确说法示例：**「左侧 **工作** 分组里点 **运行清单**」——**禁止**写成「工作 → 编排注入」。

---

## 3. 「运行清单」页内文案（`orchestrationInjectionPage`）

**「唤起归因」卡片应显示什么人话（需求真值，非本表菜单名）：** 见 [`执行/050` §产品陈述](../执行/050-运行时间线唤起溯源与档位-UI.md#产品陈述唤起归因应回答什么2026-05-20-董事会口径) · 样本问题见 [`060` §7.1–7.2](../执行/060-2026-05-20-验证闭环与编排首日执行.md#71-问题记录唤起归因卡片内容不符合定位)。

| 界面上看到的 | 常见误写 | 说明 |
| --- | --- | --- |
| **运行清单** | 编排注入 | 页标题 `title` |
| **运行详情** | — | 选中一条 run 后的详情区 `runDetailTitle` |
| **运行列表** | — | 表格标题 `runTableTitle` |
| **运行快照** | — | `contextSnapshot` 卡片 `contextSnapshot` |
| **唤起归因** | 唤醒归因、触发归因 | `wakeAttributionTitle` |
| **合并后认账的触发** | — | `wakeAttributionWinningLabel` |
| **被合并吸收的其他触发** | — | `wakeAttributionAbsorbedTitle` |
| **返回运行列表** | — | `backToList` |

深链：`/{公司前缀}/runs/{runId}` → **运行清单** 下的 **运行详情**（列表页 `/{公司前缀}/runs`）。

**旧路由（废弃，须 301/客户端重定向）：** `orchestration-injection`、`orchestration-injection/runs/:runId` — 书签与文档勿再写。

---

## 4. 事务详情页（`issueDetailUi` + `runLedger`）

| 界面上看到的 | 常见误写 | 说明 |
| --- | --- | --- |
| **收件箱** / **事务清单** → 打开某事务 | 「工单」若团队不用则可避免 | 入口 |
| 评论流 + **事务运行账本** | 笼统叫「时间线」 | `runLedger.ariaSection`；组件 `IssueRunLedger` |
| **运行**（行标签） | — | `runLedger.runLabel` / `runLabel` |
| **属性** | — | `issueDetailUi.properties` |

**050 第二期** 要在 **事务详情** 的评论区 / **事务运行账本** 里补 **唤起归因**，不是在 **运行清单** 再做一个新页。

---

## 5. 废弃口径对照（写文档时全文替换）

| 废弃（勿再写进新执行单/助手步骤） | 改用 |
| --- | --- |
| 编排注入、编排注入页 | **运行清单** |
| 工作 → 编排注入 | **工作** 分组 → **运行清单** |
| 编排注入 · 唤起归因 | **运行清单** · **唤起归因** |
| E1 前半 / E1 后半（对人说明时） | **第一期：运行清单** / **第二期：事务详情（事务运行账本）** |
| 时间线合一屏（无上下文时） | **事务详情：评论 + 事务运行账本** |

**仍可能保留旧英文名的场景（仅过渡期）：** git 历史、旧 PR、书签；新代码/新文档 **禁止** 再写 `orchestration-injection`。

**勿改含义的 homograph：** 编排协议里「由编排注入下游节点」等 **DAG 语境** 与 UI **运行清单** 无关，见 [`编排/研究任务单-编排落地与协议研读-临时.md`](../编排/研究任务单-编排落地与协议研读-临时.md)。

---

## 6. 路由改名：`orchestration-injection` → `runs`（董事会 · 2026-05-20 · **已落地**）

| 层 | 现行（废弃） | 目标 | 说明 |
| --- | --- | --- | --- |
| **URL** | `/orchestration-injection` | `/runs` | 与智能体下 `/agents/:id/runs` 同一「run」词汇 |
| **URL** | `/orchestration-injection/runs/:runId` | `/runs/:runId` | 去掉路径里重复的 `runs` 段 |
| **兼容** | — | 旧路径 **重定向** 到新路径 | `App.tsx` + 无公司前缀的 `UnprefixedBoardRedirect` |
| **板级根** | `company-routes.ts` 登记 `orchestration-injection` | 改为 `runs` | 公司前缀解析 |
| **链接** | `Sidebar`、`OrchestrationGates`、`orchestration-gates-copy` 等 | 全部 `/runs` | 已改；真值见 `ui/src/lib/run-routes.ts` |
| **代码名（可二期）** | `OrchestrationInjection*.tsx`、`orchestrationInjectionPage` | `RunListPage` / `RunDetailPage`、`runListPage` 等 | 与 [050 §Run 呈现统一](../执行/050-运行时间线唤起溯源与档位-UI.md) 合并做单；**`runLedger`（事务运行账本）勿混** |

**不动：** `/orchestration-gates`（**编排闸门**，调度说明页，不是运行清单）。

**验收：** 侧边栏进 **运行清单** 地址栏为 `…/runs`；旧书签打开仍落到同一页。

---

## 7. 写单 / 探查 / 助手自检清单

1. 提到 Board 操作前，在 `i18n.ts` 搜中文或搜路由段确认.label。  
2. 执行单「验证证据」表头用 **运行清单**，不用编排注入。  
3. 母本 **24** 的 E1–E3 编号可保留作追溯；**060 类给人跑的步骤** 应链到本表或改用 §5 右列说法。  
4. 历史文档（如 **5 月 17 日对话**）顶部有提示的，以本表为准，不批量改历史正文。

---

## 修改记录

| 日期 | 摘要 |
| --- | --- |
| 2026-05-20 | UI：`App.tsx` 新路由 + 旧路径重定向；`run-routes.ts` |
| 2026-05-20 | §6：路由真值 `orchestration-injection` → `/runs`、`/runs/:runId`；旧路径仅兼容重定向 |
| 2026-05-20 | 首版：根治「编排注入」与 **运行清单** 错位；固定侧边栏路径与 050/060 分期说法 |
