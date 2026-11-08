// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import { FRONTMATTER_FIELD_LABELS } from "./FileTree";
import { reservedRootLabel, skillFolderPathDisplayFallback } from "./folders/skill-folder-tree";
import { commentAttributionTooltip } from "./CommentAttributionChip";
import { ActivityList } from "./ActivityList";
import { CollectionToolbar } from "./CollectionToolbar";
import { IssueRowDetailsNotice } from "./IssueRowDetailsNotice";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
beforeEach(async () => { await i18n.changeLanguage("en"); host=document.createElement("div"); root=createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); await i18n.changeLanguage("en"); });
it("refreshes exported frontmatter and reserved-folder display metadata, not system keys or custom names", async () => {
 expect(FRONTMATTER_FIELD_LABELS.name).toBe("Name");
 await i18n.changeLanguage("zh-CN"); expect(FRONTMATTER_FIELD_LABELS.name).toBe("名称"); expect(FRONTMATTER_FIELD_LABELS.reportsTo).toBe("汇报对象"); expect(FRONTMATTER_FIELD_LABELS.targetDate).toBe("目标日期");
 expect(reservedRootLabel({systemKey:"my",name:"Custom"})).toBe("我的技能"); expect(reservedRootLabel({systemKey:"vendor",name:"Original name"})).toBe("Original name"); expect(skillFolderPathDisplayFallback("my/custom-name")).toContain("我的技能");
 await i18n.changeLanguage("en"); expect(FRONTMATTER_FIELD_LABELS.name).toBe("Name"); expect(reservedRootLabel({systemKey:"my",name:"Custom"})).toBe("My Skills");
});
it("uses a complete attribution explanation with untouched actor names", async () => {
 expect(commentAttributionTooltip("Agent RAW","User RAW")).toContain("Agent RAW posted this on behalf of User RAW.");
 await i18n.changeLanguage("zh-CN"); expect(commentAttributionTooltip("Agent RAW","User RAW")).toBe("Agent RAW 代表 User RAW 发布了此内容。Agent RAW 未被分配到此任务；它在此处的写入权限来自 User RAW，且绝不超出该用户的权限。");
});
it("updates mounted collection, activity, budget and optional-detail accessibility copy", async () => {
 act(()=>root.render(<><BudgetSidebarMarker level="warning"/><ActivityList events={[]} agentMap={new Map()} entityNameMap={new Map()}/><CollectionToolbar/><IssueRowDetailsNotice error={new Error("RAW")} onRetry={()=>{}}/></>));
 expect(host.querySelector("[aria-label='Budget warning']")).not.toBeNull();
 await act(async()=>{await i18n.changeLanguage("zh-CN");});
 expect(host.querySelector("[aria-label='预算警告']")).not.toBeNull(); expect(host.querySelector("[aria-label='最近活动']")).not.toBeNull(); expect(host.querySelector("[aria-label='集合控件']")).not.toBeNull(); expect(document.body.textContent).toContain("部分任务详情无法加载。");
});
