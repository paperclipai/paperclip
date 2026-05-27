# UI 国际化（i18n）硬编码字符串改造计划

## 概述

Paperclip UI 已完整接入 `i18next` + `react-i18next` 国际化框架，`ui/src/i18n/locales/en.json`（~4400 行）定义了全量翻译键，`zh-CN.json` 等 39 个语言包通过 `i18nextResources` 加载。但大量前端文件中仍存在直接写死的用户可见字符串，未通过 `t()` 提取。

**目标**：逐文件扫描 `ui/src/pages/`、`ui/src/components/` 下的所有 TSX 文件，将硬编码字符串迁移至 `t()` 调用并补齐 en.json 翻译键，使 UI 完全可本地化。

**不涉及**：
- 非用户可见字符串（内部变量、注释、console.log、Error 构造参数）
- `server/` 后端代码
- 测试断言中仅用于匹配 DOM 的字符串

---

## 1. 现有 i18n 实现分析

### 1.1 基础设施

```
ui/src/i18n/
├── index.ts              # i18n 初始化 + useTranslation / t() / changeLanguage 导出
├── locales.ts            # 动态加载 locales/{en,zh-CN,...}.json
├── locale-validation.ts  # 翻译键完整性 + XSS/URL 安全检查
├── locale-validation.test.ts
└── locales/
    ├── en.json           # ~4400 行，英语（源语言）
    ├── zh-CN.json        # 简体中文
    ├── ...               # 共 40 个语言包
```

- 初始化：`i18next` + `LanguageDetector` + `initReactI18next`
- 语言检测：`localStorage`（key `paperclip_locale`）→ `navigator`
- 切换：`changeLanguage(lng)` 同时写 localStorage 并调用 `i18n.changeLanguage()`

### 1.2 代码中的调用模式

**导入方式（唯一标准）**：

```ts
import { useTranslation } from "@/i18n";
```

**React 组件内**：

```tsx
function MyComponent() {
  const { t } = useTranslation();
  return <span>{t("page.dashboard.title")}</span>;
}
```

**非 React 函数（全局 t）**：

```ts
import { t } from "@/i18n";

export const typeLabel: Record<string, string> = {
  hire_agent: t("approval.hireAgent"),
  ceo_strategy: t("approval.ceoStrategy"),
};
```

**defaultValue 兜底（现有用法，推荐保持）**：

```tsx
t("app.noCompanies.title", { defaultValue: "Create your first company" })
```

### 1.3 en.json 结构

翻译键为**嵌套 JSON 对象**，通过点号路径引用。顶级 namespace 如下：

```json
{
  "app": { "noCompanies": { ... } },
  "issueChat": { "actor": { ... }, "pauseReason": { ... }, ... },
  "common": {
    "actions": { "save": "Save", "cancel": "Cancel", ... },
    "issues": { "status": { "todo": "To Do", ... } },
    "status": { "active": "Active", ... },
    "priority": { "none": "None", ... },
    "form": { "name": "Name", ... },
    "timeRange": { "today": "Today", ... }
  },
  "jsonSchemaForm": { "validation": { ... }, "select": { ... } },
  "nav": { "sidebar": { ... }, "instanceSidebar": { ... } },
  "page": {
    "dashboard": { "title": "Dashboard", "stat": { ... } },
    "activity": { "title": "Activity", "filter": { ... } },
    "notFound": { "pageNotFound": "Page not found", ... },
    "issueDetail": { "notFound": "Issue not found", ... },
    "agentDetail": { "assignTask": "Assign Task", ... },
    "agent": { "tab": { "dashboard": "Dashboard", ... } },
    "companies": { ... },
    ...
  },
  "component": {
    "systemNotice": { ... },
    "sidebarSection": { ... },
    "sidebarAccountMenu": { ... },
    "finance": { ... },
    ...
  },
  "approval": { "hireAgent": "Hire agent", ... },
  "finance": { "lifetimeBudget": "Lifetime budget", ... },
  "goal": { "none": "None", ... },
  "markdownBody": { "issue": "Issue", ... },
  "markdownEditor": { ... },
  "activityCharts": { "noRunsYet": "No runs yet", ... },
  "pages": { "notFound": { "backToDashboard": "Back to Dashboard", ... } }
}
```

**已知不一致**：同时存在 `page.notFound.*` 和 `pages.notFound.*` 两套键，改造时按 `page.notFound.*` 统一。

---

## 2. 翻译键命名规范

**遵循现有风格，不另起炉灶。**

| 模式 | 示例 | 对应 en.json 路径 |
|---|---|---|
| `page.<PageName>.<detail>` | `page.agentDetail.assignTask` | `{ page: { agentDetail: { assignTask: "" } } }` |
| `component.<ComponentName>.<detail>` | `component.sidebarSection.collapse` | `{ component: { sidebarSection: { collapse: "" } } }` |
| `common.<category>.<detail>` | `common.actions.save` | `{ common: { actions: { save: "" } } }` |
| `nav.<section>.<detail>` | `nav.sidebar.dashboard` | `{ nav: { sidebar: { dashboard: "" } } }` |
| `app.<area>.<detail>` | `app.noCompanies.title` | `{ app: { noCompanies: { title: "" } } }` |
| `activityCharts.<detail>` | `activityCharts.noRunsYet` | `{ activityCharts: { noRunsYet: "" } }` |

**原则**：
1. **优先复用**已有 namespace，不另造。按钮文字优先用 `common.actions.*`
2. **camelCase 命名**层级键（`agentDetail`、`noCompanies`、`sidebarAccountMenu`）
3. **最多 4 层**嵌套
4. **现有 namespace 作第一级**：不改动 `page`/`component`/`common`/`nav`/`approval`/`finance`/`goal`
5. **新增页面 key**：`page.org.*`、`page.workspaces.*`

---

## 3. 覆盖现状：硬编码字符串盘点

### 3.1 完全未接入 i18n 的页面（需新增 import + 全部替换）

| 文件 | 行数 | 优先级 |
|---|---|---|
| `pages/Org.tsx` | ~300 | P1 |
| `pages/OrgChart.tsx` | ~200 | P1 |
| `pages/Search.tsx` | ~200 | P2 |
| `pages/Workspaces.tsx` | ~300 | P1 |

### 3.2 已接入但可能遗漏的场景

即使已 `import { useTranslation }`，以下写法常被绕开：

- **aria-label 属性**：`aria-label="Close"` → `aria-label={t("common.actions.close")}`
- **placeholder**：`placeholder="Search..."` → `placeholder={t("page.search.placeholder")}`
- **toast/pushToast**：`pushToast({ title: "Saved" })` → `pushToast({ title: t("common.saved") })`
- **DialogTitle / SheetTitle**：`<DialogTitle>Confirm</DialogTitle>` → `<DialogTitle>{t("...")}</DialogTitle>`
- **EmptyState message prop**：`<EmptyState message="No data" />` → 调用方传 `t()`
- **TooltipContent / HoverCard** 中的纯文字
- **下拉选项 label** 中直接写 `"To Do"`
- **字符串拼接**：`` `${status} items` `` → `t("...", { count })`

### 3.3 en.json 死键风险

改造过程中若发现 en.json 中存在未被任何代码引用的键，标记为可清理。

---

## 4. 改造方案

### 4.1 字符串提取模式

**模式 A：JSX 子元素**

```tsx
// 改造前
<Button>Save Changes</Button>

// 改造后
<Button>{t("common.actions.saveChanges")}</Button>
```

**模式 B：属性值（aria-label / placeholder）**

```tsx
// 改造前
<input placeholder="Search..." aria-label="Search issues" />

// 改造后
<input
  placeholder={t("page.search.placeholder")}
  aria-label={t("page.search.ariaLabel")}
/>
```

**模式 C：模板字面量/插值**

```tsx
// 改造前
`${count} items found`

// 改造后
t("common.count.itemsFound", { count })
```

**模式 D：options / config 对象中的 label**

```tsx
// 改造前
const STATUS_OPTIONS = [
  { value: "todo", label: "To Do" },
  { value: "done", label: "Done" },
];

// 改造后（用全局 t）
import { t } from "@/i18n";

const STATUS_OPTIONS = [
  { value: "todo", label: t("common.issues.status.todo") },
  { value: "done", label: t("common.issues.status.done") },
];
```

### 4.2 defaultValue 兜底

所有新增 `t()` 调用均附带 `defaultValue`：

```tsx
t("page.org.title", { defaultValue: "Organization" })
```

全部文件改造完成后统一复核移除 `defaultValue`。

### 4.3 非 React 作用域使用全局 t

```ts
import { t } from "@/i18n";

function makeOptions() {
  return { value: "active", label: t("common.status.active") };
}
```

### 4.4 需注意的边界案例

1. **`className` / `data-*` / `id` / `key` 等 DOM 属性**：不 i18n
2. **第三方库内部文字**（`@mdxeditor/editor`、`@assistant-ui/react` 的 Toolbar、Menu 等）：不做包装
3. **服务端返回的动态字段值**（agent name、company name 等）：不做静态翻译
4. **Error 构造函数参数**（`throw new Error("no data")`）：不包装

---

## 5. 实施步骤

### Phase 1：核心页面——P0（估算 2 天）

| 文件 | 说明 |
|---|---|
| `pages/Dashboard.tsx` | MetricCard label、图表标题、空状态、按钮 |
| `pages/Issues.tsx` | 过滤标签、按钮、空状态 |
| `pages/IssueDetail.tsx` | Tab、按钮、状态文字、对话框 |
| `components/IssuesList.tsx` | 表头、空状态、加载 |
| `pages/AgentDetail.tsx` | Tab、按钮、统计标签、状态提示（大量） |
| `pages/Inbox.tsx` | 分类标签、操作按钮、空状态 |
| `pages/Approvals.tsx` + `components/ApprovalCard.tsx` | 状态、按钮 |

### Phase 2：次要页面——P1（估算 2 天）

| 文件 | 说明 |
|---|---|
| `pages/Org.tsx` | 从 0 开始，引入 `useTranslation` |
| `pages/OrgChart.tsx` | 从 0 开始 |
| `pages/Workspaces.tsx` | 从 0 开始 |
| `pages/Costs.tsx` | 已导入，补充遗漏 |
| `pages/Goals.tsx` + `pages/GoalDetail.tsx` | 已导入，补充 |
| `pages/Projects.tsx` + `pages/ProjectDetail.tsx` | 已导入，补充 |
| `pages/Activity.tsx` | 已导入，补充 |
| `pages/Companies.tsx` | 已导入，补充 |
| `pages/CompanySettings.tsx` | 已导入，补充 |
| `pages/InstanceSettings.tsx` + 子页面 | 已导入，补充 |
| `pages/Routines.tsx` + `pages/RoutineDetail.tsx` | 已导入，补充 |
| `pages/Secrets.tsx` | 已导入，补充 |
| `pages/PluginManager.tsx` | 已导入，补充 |
| `pages/AdapterManager.tsx` | 已导入，补充 |

### Phase 3：公共组件——P2（估算 1.5 天）

| 文件 | 关注点 |
|---|---|
| `components/EmptyState.tsx` | 确保 `message` prop 使用 `t()` |
| `components/FilterBar.tsx` | filter 文字 |
| `components/NewIssueDialog.tsx` | label / placeholder |
| `components/NewProjectDialog.tsx` | label / placeholder |
| `components/CommentThread.tsx` | 操作按钮、aria-label |
| `components/KanbanBoard.tsx` | 列标题、tooltip |
| `components/Sidebar.tsx` + `SidebarSection.tsx` | 折叠标签、aria-label |
| `components/CommandPalette.tsx` | 提示文字、placeholder |
| `components/InlineEditor.tsx` | placeholder、保存状态（已有部分 t()，补充） |
| `components/InlineEntitySelector.tsx` | placeholder |
| `components/StatusBadge.tsx` / `StatusIcon.tsx` | tooltip 文字 |
| `components/PageTabBar.tsx` | tab label |
| `components/transcript/RunTranscriptView.tsx` | 折叠标签、tooltip |
| `components/ui/dialog.tsx` | 关闭按钮 aria-label（已有 t()） |
| `components/ui/sheet.tsx` | 关闭按钮 aria-label（已有 t()） |

### Phase 4：en.json 整理 + 校验（估算 0.5 天）

- 补充 Phase 1-3 新增的所有翻译键到 en.json
- 运行 `locale-validation.ts` 验证：
  - 所有语言键结构对齐 en.json
  - 无 XSS 风险（event-handler attribute、`javascript:`、`data:`、raw HTML）
  - 无意外 URL
- 标记 `pages.notFound.*` 统一到 `page.notFound.*`

---

## 6. 预计改造量

| Phase | 新增/修改翻译键 | 修改文件数 |
|---|---|---|
| Phase 1 - 核心页面 | ~80-120 | 8-10 |
| Phase 2 - 次要页面 | ~150-200 | 14-18 |
| Phase 3 - 公共组件 | ~80-120 | 20-30 |
| Phase 4 - en.json 整理 | 清理 ~5-10 死键 | 3-5 |
| **合计** | **~310-440 个翻译键** | **~45-60 个文件** |

---

## 7. 验收标准

1. 所有用户可见字符串均通过 `t()` 调用，en.json 有对应键
2. `locale-validation.ts` 验证通过
3. 页面切换 `paperclip_locale` → `zh-CN` 后 UI 主要文字对应变化
4. `pnpm test` 通过
5. `pnpm -r typecheck` 通过
6. `pnpm build` 通过

---

## 8. 回退策略

- 每个 Phase 独立提交，粒度以 page 或 component 为单位
- 过渡期 `defaultValue` 保证 UI 不空白
- 后续建议引入 ESLint 规则自动检测新硬编码字符串，防止回归
