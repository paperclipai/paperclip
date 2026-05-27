# 前端完整国际化实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为前端项目中所有 .tsx 文件实现中英文国际化支持，消除所有硬编码字符串。

**架构：** 基于已有的 i18next + react-i18next 框架，为所有页面和组件添加 `useTranslation` 钩子，将硬编码字符串替换为 `t()` 调用，并在 en.json 和 zh-CN.json 中补充翻译键。

**技术栈：** i18next, react-i18next, TypeScript, React

---

## 文件结构

### 翻译文件（需持续更新）
- `ui/src/i18n/locales/en.json` - 英文翻译
- `ui/src/i18n/locales/zh-CN.json` - 中文翻译

### 页面文件（按优先级分批处理）
**第一批：核心高频页面（8个）**
- `ui/src/pages/NotFound.tsx`
- `ui/src/pages/Inbox.tsx`
- `ui/src/pages/Search.tsx`
- `ui/src/pages/IssueDetail.tsx`
- `ui/src/pages/AgentDetail.tsx`
- `ui/src/pages/ProjectDetail.tsx`
- `ui/src/pages/UserProfile.tsx`
- `ui/src/pages/Auth.tsx`

**第二批：设置和管理页面（8个）**
- `ui/src/pages/ProfileSettings.tsx`
- `ui/src/pages/InstanceAccess.tsx`
- `ui/src/pages/InstanceExperimentalSettings.tsx`
- `ui/src/pages/PluginManager.tsx`
- `ui/src/pages/PluginSettings.tsx`
- `ui/src/pages/AdapterManager.tsx`
- `ui/src/pages/NewAgent.tsx`
- `ui/src/pages/Workspaces.tsx`

**第三批：详细页面和实验室页面（8个）**
- `ui/src/pages/ApprovalDetail.tsx`
- `ui/src/pages/RoutineDetail.tsx`
- `ui/src/pages/ProjectDetail.tsx`
- `ui/src/pages/ProjectWorkspaceDetail.tsx`
- `ui/src/pages/ExecutionWorkspaceDetail.tsx`
- `ui/src/pages/IssueChatUxLab.tsx`
- `ui/src/pages/RunTranscriptUxLab.tsx`
- `ui/src/pages/SystemNoticeUxLab.tsx`

**第四批：其他页面（8个）**
- `ui/src/pages/JoinRequestQueue.tsx`
- `ui/src/pages/InviteLanding.tsx`
- `ui/src/pages/InviteUxLab.tsx`
- `ui/src/pages/IssueChatLongThreadPerf.tsx`
- `ui/src/pages/DashboardLive.tsx`
- `ui/src/pages/DesignGuide.tsx`
- `ui/src/pages/CliAuth.tsx`
- `ui/src/pages/BoardClaim.tsx`

### 组件文件（按功能域分批处理）
**第一批：UI 基础组件（4个）**
- `ui/src/components/ui/dialog.tsx`
- `ui/src/components/ui/sheet.tsx`
- `ui/src/components/ui/command.tsx`
- `ui/src/components/ui/breadcrumb.tsx`

**第二批：Issue 相关组件（12个）**
- `ui/src/components/IssuesList.tsx`
- `ui/src/components/IssueThreadInteractionCard.tsx`
- `ui/src/components/IssueChatThread.tsx`
- `ui/src/components/IssueFiltersPopover.tsx`
- `ui/src/components/IssueProperties.tsx`
- `ui/src/components/IssueDocumentsSection.tsx`
- `ui/src/components/IssueMonitorActivityCard.tsx`
- `ui/src/components/IssueRecoveryActionCard.tsx`
- `ui/src/components/IssueRunLedger.tsx`
- `ui/src/components/IssueWorkspaceCard.tsx`
- `ui/src/components/IssueAssignedBacklogNotice.tsx`
- `ui/src/components/NewIssueDialog.tsx`

**第三批：Agent 相关组件（6个）**
- `ui/src/components/AgentConfigForm.tsx`
- `ui/src/components/AgentActionButtons.tsx`
- `ui/src/components/AgentIconPicker.tsx`
- `ui/src/components/NewAgentDialog.tsx`
- `ui/src/components/agent-config-primitives.tsx`
- `ui/src/components/SecretBindingPicker.tsx`

**第四批：Project 相关组件（4个）**
- `ui/src/components/ProjectProperties.tsx`
- `ui/src/components/ProjectWorkspaceSummaryCard.tsx`
- `ui/src/components/NewProjectDialog.tsx`
- `ui/src/components/WorkspaceRuntimeControls.tsx`

**第五批：审批和财务组件（6个）**
- `ui/src/components/ApprovalCard.tsx`
- `ui/src/components/ApprovalPayload.tsx`
- `ui/src/components/BudgetPolicyCard.tsx`
- `ui/src/components/FinanceKindCard.tsx`
- `ui/src/components/FinanceTimelineCard.tsx`
- `ui/src/components/GoalProperties.tsx`

**第六批：其他业务组件（10个）**
- `ui/src/components/CommentThread.tsx`
- `ui/src/components/DocumentDiffModal.tsx`
- `ui/src/components/EnvVarEditor.tsx`
- `ui/src/components/ExecutionWorkspaceCloseDialog.tsx`
- `ui/src/components/JsonSchemaForm.tsx`
- `ui/src/components/KeyboardShortcutsCheatsheet.tsx`
- `ui/src/components/OnboardingWizard.tsx`
- `ui/src/components/OutputFeedbackButtons.tsx`
- `ui/src/components/PathInstructionsModal.tsx`
- `ui/src/components/ProductivityReviewBadge.tsx`

**第七批：剩余组件（12个）**
- `ui/src/components/ActivityCharts.tsx`
- `ui/src/components/CloudAccessGate.tsx`
- `ui/src/components/CompanySwitcher.tsx`
- `ui/src/components/DevRestartBanner.tsx`
- `ui/src/components/PropertiesPanel.tsx`
- `ui/src/components/RoutineHistoryTab.tsx`
- `ui/src/components/RoutineRunVariablesDialog.tsx`
- `ui/src/components/RoutineVariablesEditor.tsx`
- `ui/src/components/SidebarAgents.tsx`
- `ui/src/components/SidebarCompanyMenu.tsx`
- `ui/src/components/WorktreeBanner.tsx`
- `ui/src/components/transcript/RunTranscriptView.tsx`

---

## 任务分解

### 任务 1：第一批核心页面国际化（8个页面）

**文件：**
- 修改：`ui/src/pages/NotFound.tsx`
- 修改：`ui/src/pages/Inbox.tsx`
- 修改：`ui/src/pages/Search.tsx`
- 修改：`ui/src/pages/IssueDetail.tsx`
- 修改：`ui/src/pages/AgentDetail.tsx`
- 修改：`ui/src/pages/ProjectDetail.tsx`
- 修改：`ui/src/pages/UserProfile.tsx`
- 修改：`ui/src/pages/Auth.tsx`
- 修改：`ui/src/i18n/locales/en.json`
- 修改：`ui/src/i18n/locales/zh-CN.json`

**步骤：**

- [ ] **步骤 1：为每个页面添加 useTranslation 导入**

在每个页面文件顶部添加：
```typescript
import { useTranslation } from "@/i18n";
```

- [ ] **步骤 2：在组件函数中初始化 t**

在每个组件函数开头添加：
```typescript
const { t } = useTranslation();
```

- [ ] **步骤 3：替换硬编码字符串为 t() 调用**

示例（NotFound.tsx）：
```typescript
// 替换前
<h1>Not Found</h1>
<p>The page you're looking for doesn't exist.</p>
<Button>Go home</Button>

// 替换后
<h1>{t("page.notFound.title")}</h1>
<p>{t("page.notFound.description")}</p>
<Button>{t("page.notFound.goHome")}</Button>
```

- [ ] **步骤 4：在 en.json 中添加翻译键**

```json
"page": {
  "notFound": {
    "title": "Not Found",
    "description": "The page you're looking for doesn't exist.",
    "goHome": "Go home"
  },
  "inbox": {
    "title": "Inbox",
    "empty": "No messages",
    "loading": "Loading..."
  },
  "search": {
    "title": "Search",
    "placeholder": "Search...",
    "scope": {
      "all": "All",
      "issues": "Issues",
      "comments": "Comments",
      "documents": "Documents"
    }
  }
}
```

- [ ] **步骤 5：在 zh-CN.json 中添加对应中文翻译**

```json
"page": {
  "notFound": {
    "title": "页面未找到",
    "description": "您查找的页面不存在。",
    "goHome": "返回首页"
  },
  "inbox": {
    "title": "收件箱",
    "empty": "暂无消息",
    "loading": "加载中..."
  },
  "search": {
    "title": "搜索",
    "placeholder": "搜索...",
    "scope": {
      "all": "全部",
      "issues": "任务",
      "comments": "评论",
      "documents": "文档"
    }
  }
}
```

- [ ] **步骤 6：验证翻译键一致性**

运行脚本验证 en.json 和 zh-CN.json 键结构完全匹配。

---

### 任务 2：第二批设置和管理页面国际化（8个页面）

**文件：**
- 修改：`ui/src/pages/ProfileSettings.tsx`
- 修改：`ui/src/pages/InstanceAccess.tsx`
- 修改：`ui/src/pages/InstanceExperimentalSettings.tsx`
- 修改：`ui/src/pages/PluginManager.tsx`
- 修改：`ui/src/pages/PluginSettings.tsx`
- 修改：`ui/src/pages/AdapterManager.tsx`
- 修改：`ui/src/pages/NewAgent.tsx`
- 修改：`ui/src/pages/Workspaces.tsx`
- 修改：`ui/src/i18n/locales/en.json`
- 修改：`ui/src/i18n/locales/zh-CN.json`

**步骤：**
与任务 1 相同的模式，为每个页面添加 `useTranslation`，替换硬编码字符串，更新翻译文件。

---

### 任务 3：第三批详细页面国际化（8个页面）

**文件：**
- 修改：`ui/src/pages/ApprovalDetail.tsx`
- 修改：`ui/src/pages/RoutineDetail.tsx`
- 修改：`ui/src/pages/ProjectWorkspaceDetail.tsx`
- 修改：`ui/src/pages/ExecutionWorkspaceDetail.tsx`
- 修改：`ui/src/pages/IssueChatUxLab.tsx`
- 修改：`ui/src/pages/RunTranscriptUxLab.tsx`
- 修改：`ui/src/pages/SystemNoticeUxLab.tsx`
- 修改：`ui/src/pages/InviteLanding.tsx`
- 修改：`ui/src/i18n/locales/en.json`
- 修改：`ui/src/i18n/locales/zh-CN.json`

**步骤：**
与任务 1 相同的模式。

---

### 任务 4：第四批其他页面国际化（8个页面）

**文件：**
- 修改：`ui/src/pages/JoinRequestQueue.tsx`
- 修改：`ui/src/pages/InviteUxLab.tsx`
- 修改：`ui/src/pages/IssueChatLongThreadPerf.tsx`
- 修改：`ui/src/pages/DashboardLive.tsx`
- 修改：`ui/src/pages/DesignGuide.tsx`
- 修改：`ui/src/pages/CliAuth.tsx`
- 修改：`ui/src/pages/BoardClaim.tsx`
- 修改：`ui/src/i18n/locales/en.json`
- 修改：`ui/src/i18n/locales/zh-CN.json`

**步骤：**
与任务 1 相同的模式。

---

### 任务 5：UI 基础组件国际化（4个组件）

**文件：**
- 修改：`ui/src/components/ui/dialog.tsx`
- 修改：`ui/src/components/ui/sheet.tsx`
- 修改：`ui/src/components/ui/command.tsx`
- 修改：`ui/src/components/ui/breadcrumb.tsx`
- 修改：`ui/src/i18n/locales/en.json`
- 修改：`ui/src/i18n/locales/zh-CN.json`

**步骤：**
为 UI 基础组件添加翻译支持，主要处理关闭按钮、搜索占位符等通用文本。

---

### 任务 6：Issue 相关组件国际化（12个组件）

**文件：**
- 修改：`ui/src/components/IssuesList.tsx`
- 修改：`ui/src/components/IssueThreadInteractionCard.tsx`
- 修改：`ui/src/components/IssueChatThread.tsx`
- 修改：`ui/src/components/IssueFiltersPopover.tsx`
- 修改：`ui/src/components/IssueProperties.tsx`
- 修改：`ui/src/components/IssueDocumentsSection.tsx`
- 修改：`ui/src/components/IssueMonitorActivityCard.tsx`
- 修改：`ui/src/components/IssueRecoveryActionCard.tsx`
- 修改：`ui/src/components/IssueRunLedger.tsx`
- 修改：`ui/src/components/IssueWorkspaceCard.tsx`
- 修改：`ui/src/components/IssueAssignedBacklogNotice.tsx`
- 修改：`ui/src/components/NewIssueDialog.tsx`
- 修改：`ui/src/i18n/locales/en.json`
- 修改：`ui/src/i18n/locales/zh-CN.json`

**步骤：**
为 Issue 相关组件添加翻译，更新 `component.issue.*` 命名空间。

---

### 任务 7：Agent 相关组件国际化（6个组件）

**文件：**
- 修改：`ui/src/components/AgentConfigForm.tsx`
- 修改：`ui/src/components/AgentActionButtons.tsx`
- 修改：`ui/src/components/AgentIconPicker.tsx`
- 修改：`ui/src/components/NewAgentDialog.tsx`
- 修改：`ui/src/components/agent-config-primitives.tsx`
- 修改：`ui/src/components/SecretBindingPicker.tsx`
- 修改：`ui/src/i18n/locales/en.json`
- 修改：`ui/src/i18n/locales/zh-CN.json`

**步骤：**
为 Agent 相关组件添加翻译，更新 `component.agent.*` 命名空间。

---

### 任务 8：Project 相关组件国际化（4个组件）

**文件：**
- 修改：`ui/src/components/ProjectProperties.tsx`
- 修改：`ui/src/components/ProjectWorkspaceSummaryCard.tsx`
- 修改：`ui/src/components/NewProjectDialog.tsx`
- 修改：`ui/src/components/WorkspaceRuntimeControls.tsx`
- 修改：`ui/src/i18n/locales/en.json`
- 修改：`ui/src/i18n/locales/zh-CN.json`

**步骤：**
为 Project 相关组件添加翻译，更新 `component.project.*` 命名空间。

---

### 任务 9：审批和财务组件国际化（6个组件）

**文件：**
- 修改：`ui/src/components/ApprovalCard.tsx`
- 修改：`ui/src/components/ApprovalPayload.tsx`
- 修改：`ui/src/components/BudgetPolicyCard.tsx`
- 修改：`ui/src/components/FinanceKindCard.tsx`
- 修改：`ui/src/components/FinanceTimelineCard.tsx`
- 修改：`ui/src/components/GoalProperties.tsx`
- 修改：`ui/src/i18n/locales/en.json`
- 修改：`ui/src/i18n/locales/zh-CN.json`

**步骤：**
为审批和财务组件添加翻译，更新 `component.approval.*` 和 `component.finance.*` 命名空间。

---

### 任务 10：其他业务组件国际化（10个组件）

**文件：**
- 修改：`ui/src/components/CommentThread.tsx`
- 修改：`ui/src/components/DocumentDiffModal.tsx`
- 修改：`ui/src/components/EnvVarEditor.tsx`
- 修改：`ui/src/components/ExecutionWorkspaceCloseDialog.tsx`
- 修改：`ui/src/components/JsonSchemaForm.tsx`
- 修改：`ui/src/components/KeyboardShortcutsCheatsheet.tsx`
- 修改：`ui/src/components/OnboardingWizard.tsx`
- 修改：`ui/src/components/OutputFeedbackButtons.tsx`
- 修改：`ui/src/components/PathInstructionsModal.tsx`
- 修改：`ui/src/components/ProductivityReviewBadge.tsx`
- 修改：`ui/src/i18n/locales/en.json`
- 修改：`ui/src/i18n/locales/zh-CN.json`

**步骤：**
为其他业务组件添加翻译。

---

### 任务 11：剩余组件国际化（12个组件）

**文件：**
- 修改：`ui/src/components/ActivityCharts.tsx`
- 修改：`ui/src/components/CloudAccessGate.tsx`
- 修改：`ui/src/components/CompanySwitcher.tsx`
- 修改：`ui/src/components/DevRestartBanner.tsx`
- 修改：`ui/src/components/PropertiesPanel.tsx`
- 修改：`ui/src/components/RoutineHistoryTab.tsx`
- 修改：`ui/src/components/RoutineRunVariablesDialog.tsx`
- 修改：`ui/src/components/RoutineVariablesEditor.tsx`
- 修改：`ui/src/components/SidebarAgents.tsx`
- 修改：`ui/src/components/SidebarCompanyMenu.tsx`
- 修改：`ui/src/components/WorktreeBanner.tsx`
- 修改：`ui/src/components/transcript/RunTranscriptView.tsx`
- 修改：`ui/src/i18n/locales/en.json`
- 修改：`ui/src/i18n/locales/zh-CN.json`

**步骤：**
为剩余组件添加翻译。

---

### 任务 12：验证和测试

**步骤：**

- [ ] **步骤 1：运行类型检查**

```bash
pnpm -r typecheck
```

预期：无类型错误

- [ ] **步骤 2：运行测试**

```bash
pnpm test
```

预期：所有测试通过

- [ ] **步骤 3：验证翻译键一致性**

运行脚本验证 en.json 和 zh-CN.json 键结构完全匹配：

```bash
node scripts/verify-i18n-keys.js
```

预期：所有键匹配

- [ ] **步骤 4：启动开发服务器手动测试**

```bash
pnpm dev
```

访问 http://localhost:3100，切换语言验证所有页面文本正确显示。

---

## 自检

**1. 规格覆盖度：**
- ✅ 所有 86 个需要国际化的文件都已分配到任务中
- ✅ 翻译文件更新已包含在每个任务中
- ✅ 验证和测试任务已包含

**2. 占位符扫描：**
- ✅ 无 "TODO"、"待定" 等占位符
- ✅ 每个步骤都有具体操作说明

**3. 类型一致性：**
- ✅ 所有页面使用相同的 `useTranslation` 导入路径
- ✅ 翻译键命名遵循 `page.xxx.*` 和 `component.xxx.*` 模式

---

计划已完成并保存到 `doc/plans/2026-05-18-frontend-i18n-complete.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
