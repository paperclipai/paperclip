---
id: exec-030-issue-properties-i18n
status: 已完成
updated: "2026-05-16"
---

# 执行任务单 #030 — IssueProperties 右侧属性面板全量汉化

## 可复用打法

共性步骤见 **[011-实践-回形针UI页面汉化流程.md](../最佳实践/011-实践-回形针UI页面汉化流程.md)**（本单为 **IssueProperties** 实例）。

## 范围

- **场景**：Paperclip UI 中事务详情页右侧 Properties 面板（`IssueProperties.tsx`，2078 行）的所有用户可见英文文案。
- **连带组件**：`PropertiesPanel.tsx`（容器标题）
- **排除**：技术占位符、API 返回动态值、AI 智能体生成文本、`data-testid`、类名、URL、包名、测试文件

## 结果

| 指标 | 值 |
|------|---|
| 修改文件总数 | **2 个**（1 个 i18n 字典 + 1 个组件） |
| 新增翻译 key | **~170 个**（`issuePropertiesPage`、`thinkingEffortOptions`、`assigneeOptionsLabels`） |
| 替换英文文案 | **~135 处** |
| TypeScript 错误 | 0（本次改动范围内） |
| 逻辑/类型/CSS 变更 | 0 |

## 踩坑与经验

| 坑 | 经验 |
|---|------|
| `ISSUE_THINKING_EFFORT_OPTIONS` 是 value→label 映射，不能简单替换 label | 保留 value 映射表 `THINKING_EFFORT_VALUE_LABELS`，只汉化 label |
| 文件太大（2078 行），批量替换 PowerShell 路径有问题 | 改用逐个 edit，确保每个替换精确定位 |
| `thinkingEffortOptions.forAdapter()` 返回 label 数组，但 API 需要 value | 需要反向查找 value，用 `THINKING_EFFORT_VALUE_LABELS` 映射 |

## 验证命令

```bash
npx tsc --noEmit 2>&1 | findstr /i "error TS"
# 仅 tsconfig.json 预存引用错误（droid-local），本次改动零错误
```

---

**完成日期**：2026-05-16
