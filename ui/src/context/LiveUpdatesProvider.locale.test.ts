import { afterEach, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { i18n } from "@/i18n";
import { __liveUpdatesTestUtils as live } from "./LiveUpdatesProvider";

afterEach(async () => { await i18n.changeLanguage("en"); });
it("retains keyed live-notification presentation across locale changes without translating raw names, diagnostics, IDs or event data", async () => {
  await i18n.changeLanguage("en"); const client = new QueryClient();
  const payload = { entityType:"issue",entityId:"raw-id",action:"issue.created",actorType:"user",actorId:"raw-user",actorName:"System",details:{identifier:"RAW-1",title:"Raw task"} };
  const snapshot = JSON.stringify(payload);
  const toast = live.buildActivityToast(client,"c",payload,{userId:null,agentId:null})!;
  const run = live.buildRunStatusToast({runId:"raw-run",agentId:"raw-agent",status:"failed",error:"System"},()=>null)!;
  expect(toast.title).toBe("System created RAW-1"); expect(run.title).toBe("Agent run failed");
  const href = toast.action?.href;
  await i18n.changeLanguage("zh-CN");
  expect(toast.title).toBe("System 创建了 RAW-1"); expect(run.title).toBe("智能体运行失败");
  expect(toast.action?.label).toBe("查看 RAW-1"); expect(toast.action?.href).toBe(href);
  expect(toast.body).toBe("Raw task"); expect(run.body).toBe("System"); expect(JSON.stringify(payload)).toBe(snapshot);
  await i18n.changeLanguage("en"); expect(toast.title).toBe("System created RAW-1"); expect(run.title).toBe("Agent run failed");
  client.clear();
});
