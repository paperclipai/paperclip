---
id: exec-031-activity-page-i18n
status: 已完成
updated: "2026-05-16"
---

# 执行任务单 #031 — Activity 活动页汉化

## 可复用打法

共性步骤见 **[011-实践-回形针UI页面汉化流程.md](../最佳实践/011-实践-回形针UI页面汉化流程.md)**（本单为 **Activity** 实例）。

## 结果

| 指标 | 值 |
|------|---|
| 修改文件总数 | **4 个**（i18n + Activity.tsx + ActivityRow.tsx + activity-format.ts） |
| 新增翻译 key | **~130 个**（`activityPage`、`activityRowLabels`、`activityVerbs`、`activityLabels`、`activityChangeLabels`） |
| 替换英文文案 | **~110 处** |
| TypeScript 错误 | 0 |

## 改动

| 文件 | 改动 |
|------|------|
| `ui/src/lib/i18n.ts` | 新增 `activityPage`、`activityRowLabels`、`activityVerbs`、`activityLabels`、`activityChangeLabels` |
| `ui/src/pages/Activity.tsx` | 面包屑、空状态、筛选器 → i18n |
| `ui/src/components/ActivityRow.tsx` | "System"/"Board"/"Unknown" → i18n |
| `ui/src/lib/activity-format.ts` | 两个英文字典改为引用 i18n；结构化变更文案（状态/优先级变更、阻塞/审查/审批更新）全部汉化 |

## 验证命令

```bash
npx tsc --noEmit 2>&1 | findstr /i "error TS"
# 仅预存 droid-local 引用错误，本次改动零错误
```

---

**完成日期**：2026-05-16
