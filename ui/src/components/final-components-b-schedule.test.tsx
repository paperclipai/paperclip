// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { ScheduleEditor, describeSchedule, buildCron, getScheduleCronValidation } from "./ScheduleEditor";
import { AiConnectionUsagePanel } from "./ai-connections/AiConnectionUsagePanel";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement,root:Root;
beforeEach(async()=>{await i18n.changeLanguage("en");host=document.createElement("div");root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());await i18n.changeLanguage("en");});
it("formats schedule display independently from cron values and the English AM/PM predicates",async()=>{
 const cron="0 10 * * *";expect(describeSchedule(cron)).toBe("Every day at 10:00 AM");
 await i18n.changeLanguage("zh-CN");expect(describeSchedule(cron)).toBe("每天 10:00");expect(describeSchedule("5 0 * * 1-5")).toBe("工作日 00:05");expect(buildCron("every_day","10","0","1","1")).toBe(cron);expect(getScheduleCronValidation("* * * * *").message).toBe("cron 表达式有效。");
});
it("localizes generated usage periods only after canonical English deduplication and retains raw provider labels/data",async()=>{
 const observation={status:"ok",checkedAt:"2026-10-01T00:00:00Z",limits:[{id:"a",label:"Vendor Primary",windowDurationSeconds:18000,used:0,limit:0,unit:null},{id:"b",label:"5 hour limit",windowDurationSeconds:18000,used:0,limit:0,unit:null},{id:"c",label:"weekly limit",windowDurationSeconds:604800,used:0,limit:0,unit:null}]} as any;
 const snapshot=JSON.stringify(observation);const account={provider:"anthropic",method:"subscription",status:"connected",companyId:"c",id:"a"} as any;
 act(()=>root.render(<QueryClientProvider client={new QueryClient()}><AiConnectionUsagePanel account={account} observation={observation} cachedOnly/></QueryClientProvider>));expect(host.textContent).toContain("Vendor Primary · 5h");
 await act(async()=>{await i18n.changeLanguage("zh-CN");});expect(host.textContent).toContain("Vendor Primary · 5 小时");expect(host.textContent).not.toContain("5 小时 · 5 小时");expect(JSON.stringify(observation)).toBe(snapshot);
});
