// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { i18n, Trans } from "@/i18n";
const files = ["BudgetPolicyCard.tsx","ClaudeSubscriptionPanel.tsx","DocumentAnnotationPanel.tsx","issue-properties/IssueProperties.tsx","IssueBlockedNotice.tsx","IssuesList.tsx","IssueThreadInteractionCard.tsx","JsonSchemaForm.tsx","KanbanBoard.tsx","RoutineHistoryTab.tsx","task-chat/TaskChatComposer.tsx","TaskList.tsx","transcript/RunTranscriptView.tsx","WorkspaceFileBrowser.tsx","WorkspaceServiceControlBar.tsx"];
afterEach(async()=>{await i18n.changeLanguage("en");});
it("uses interpolation rather than numeric component children at the exact owned numeric Trans sites",()=>{
 const unsafe = files.flatMap(file=>{
  const source=fs.readFileSync(path.resolve(import.meta.dirname,file),"utf8");
  return [...source.matchAll(/part\d+:\s*<>\{([^{}]+)\}<\/>/g)].filter(m=>!m[1].includes(" ? ") && /\.length|Count\b|Percent\b|revisionNumber\b|^index \+ 1$|^pageSize$|RESULT_LIMIT$|^total$|^doneCount$|^runningCount$|^runningCount$/.test(m[1])).map(m=>file+": "+m[1]);
 });expect(unsafe).toEqual([]);
});
it("renders all migrated numeric message values at zero and nonzero in both locales",async()=>{
 const en=JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname,"../i18n/catalogs/en/final-components-b.json"),"utf8"));
 const keys=Object.keys(en).filter(key=>key.startsWith("numeric."));expect(keys.length).toBeGreaterThan(25);
 const host=document.createElement("div"), root=createRoot(host);
 try { for(const locale of ["en","zh-CN"]) {await i18n.changeLanguage(locale); for(const key of keys){const fields=[...en[key].matchAll(/\{\{(\w+)\}\}/g)].map((m:any)=>m[1]);for(const number of [0,4]) {const values=Object.fromEntries(fields.map((field:string)=>[field,number]));await act(async()=>root.render(<Trans ns="final-components-b" i18nKey={key} values={values}/>));expect(host.textContent,locale+" "+key).toContain(String(number));expect(host.textContent).not.toContain("{{");}}}}
 finally { await act(async()=>root.unmount()); }
});
