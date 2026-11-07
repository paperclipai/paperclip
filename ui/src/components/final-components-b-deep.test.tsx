// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { BudgetPolicyCard } from "./BudgetPolicyCard";
import { ArtifactFileChip } from "./ArtifactFileChip";
import { WorkspaceFileLink } from "./WorkspaceFileLink";
import { RunTranscriptView } from "./transcript/RunTranscriptView";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
beforeEach(async()=>{await i18n.changeLanguage("en");host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();await i18n.changeLanguage("en");});
it("renders zero/nonzero budget percentages and pause context in both locales without resetting drafts",async()=>{
 const summary={amount:10000,observedAmount:0,remainingAmount:10000,utilizationPercent:0,warnPercent:0,windowKind:"monthly",status:"healthy",paused:true,pauseReason:"manual",pendingRunCount:0,unpricedEventCount:0,reservationCents:"0.0000000"} as any;
 act(()=>root.render(<BudgetPolicyCard summary={summary} onSave={()=>{}}/>));
 expect(host.textContent).toContain("Soft alert at 0%"); const input=host.querySelector("input")!;
 await act(async()=>{await i18n.changeLanguage("zh-CN");}); expect(host.textContent).toContain("达到 0% 时警告"); expect(host.textContent).toContain("手动暂停");expect(host.querySelector("input")).toBe(input);
 act(()=>root.render(<BudgetPolicyCard summary={{...summary,warnPercent:80}} onSave={()=>{}}/>)); expect(host.textContent).toContain("达到 80% 时警告");
 await act(async()=>{await i18n.changeLanguage("en");});expect(host.textContent).toContain("Soft alert at 80%");
});
it("updates full file accessibility messages while preserving paths, data and modified-click guards",async()=>{
 const ref={displayPath:"Raw / src/File.ts",relativePath:"src/File.ts",path:"src/File.ts",workspaceKind:"execution_workspace",line:3,column:2} as any;const original=JSON.stringify(ref),onOpen=vi.fn();
 act(()=>root.render(<ArtifactFileChip workspaceFileRef={ref} onOpen={onOpen}/>));const button=host.querySelector("button")!;
 expect(button.getAttribute("aria-label")).toBe("Open Raw / src/File.ts line 3 column 2 in the file viewer");
 await act(async()=>{await i18n.changeLanguage("zh-CN");});expect(button.getAttribute("aria-label")).toBe("在文件查看器中打开 Raw / src/File.ts 第 3 行第 2 列");
 act(()=>button.dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true})));expect(onOpen).not.toHaveBeenCalled();act(()=>button.click());expect(onOpen).toHaveBeenCalledWith(ref);expect(JSON.stringify(ref)).toBe(original);
});
it("updates normalized transcript presentation live and preserves raw protocol output",async()=>{
 const entries=[{kind:"workspace_change",ts:"2026-01-01T00:00:00Z",complete:true,totals:{files:0,added:0,removed:0},source:"runner_verified",revision:0}] as any;
 act(()=>root.render(<RunTranscriptView entries={entries}/>));expect(host.textContent).toContain("0 changed files");
 await act(async()=>{await i18n.changeLanguage("zh-CN");});expect(host.textContent).toContain("0 个已更改文件");
 act(()=>root.render(<RunTranscriptView entries={entries} mode="raw"/>));expect(host.textContent).toContain("0 files · runner_verified · revision 0");expect(entries[0].source).toBe("runner_verified");
});

it("localizes an anonymous diff heading while preserving its patch data",async()=>{
 const entries=[{kind:"diff",ts:"2026-01-01T00:00:00Z",text:"@@ -1 +1 @@\n-before\n+after",changeType:"update"}] as any;
 const original=JSON.stringify(entries);await i18n.changeLanguage("zh-CN");act(()=>root.render(<RunTranscriptView entries={entries}/>));expect(host.textContent).toContain("差异");expect(JSON.stringify(entries)).toBe(original);
});
