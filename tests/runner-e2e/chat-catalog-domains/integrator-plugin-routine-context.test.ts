import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { PluginRecord } from "../../../packages/shared/src/types/plugin.js";
import type { RoutineDetail } from "../../../packages/shared/src/types/routine.js";
const reads = vi.hoisted(() => ({ source: undefined as unknown, routine: undefined as unknown, status: 200 }));
vi.mock("./identity-support.js", async original => ({ ...await original<object>(),
  openStandingChat: async (ctx: ChatCatalogContext) => ctx.issue(),
  readAgentResource: async (_ctx: unknown, url: string) => ({ status: reads.status, data: url.includes("/issues/") ? reads.source : reads.routine }),
}));
import { managedRoutineContext, prepareManagedRoutineContext } from "./integrator-plugin-routine.js";
function resources() {
  const plugin = { id: "plugin", manifestJson: { id: "selected.plugin", displayName: "Daily Maintenance Eval" } } as PluginRecord;
  const routine = { id: "routine", companyId: "company", title: "Plugin daily maintenance", managedByPlugin: { pluginId: "plugin", pluginKey: "selected.plugin", resourceKind: "routine", resourceKey: "daily-maintenance" } } as RoutineDetail;
  return { plugin, routine };
}
function context() {
  let calls = 0;
  const source = { id: "source", companyId: "company", assigneeAgentId: "ceo", description: null as string | null };
  const patch = vi.fn(async (_url: string, body: { description: string }) => { source.description = body.description; return source; });
  const evidence = vi.fn(async () => {});
  const ctx = { input: { fixtures: { company: { id: "company", issuePrefix: "RUN" }, agent: { id: "ceo" } },
    api: { patch, get: vi.fn(async (url: string) => url.endsWith("/comments") ? [] : source) }, evidence }, issue: () => source, refreshIssue: async () => {}, allRuns: vi.fn(async () => { calls++; return calls > 1 && lateRun ? [{ id: "unexpected" }] : []; }) } as unknown as ChatCatalogContext;
  let lateRun = false;
  reads.source = source;
  return { ctx, source, patch, evidence, lateRun: () => { lateRun = true; } };
}
beforeEach(() => { reads.status = 200; vi.stubGlobal("fetch", () => { throw new Error("No network allowed"); }); });
afterEach(() => vi.unstubAllGlobals());
it("writes only actual selected resource facts and independently reads them as CEO before any work", async () => {
  const r = resources(), c = context(); reads.routine = r.routine;
  const receipt = await prepareManagedRoutineContext(c.ctx, r.plugin, r.routine);
  expect(c.patch).toHaveBeenCalledExactlyOnceWith("/api/issues/source", { description: managedRoutineContext("company", "RUN", r.plugin, r.routine) });
  const facts = JSON.parse(c.source.description!.split("\n").slice(1).join("\n"));
  expect(facts).toEqual({ routine: { id: "routine", title: "Plugin daily maintenance", url: "/RUN/routines/routine" }, plugin: { id: "plugin", key: "selected.plugin", name: "Daily Maintenance Eval", url: "/RUN/plugins/plugin" } });
  expect(c.source.description).not.toMatch(/ownership|configuration|maintainer|rewrite|paused|operator/i);
  expect(receipt.prequeryRuns).toBe(0); expect(receipt.ceoSourceStatus).toBe(200); expect(c.evidence).toHaveBeenCalledOnce();
});
it.each(["foreign-company", "wrong-plugin", "wrong-key", "wrong-resource"])("rejects %s factual context before any write", async kind => {
  const r = resources(), c = context(); reads.routine = r.routine;
  if (kind === "foreign-company") r.routine.companyId = "foreign";
  if (kind === "wrong-plugin") r.routine.managedByPlugin!.pluginId = "other";
  if (kind === "wrong-key") r.routine.managedByPlugin!.pluginKey = "other";
  if (kind === "wrong-resource") r.routine.managedByPlugin!.resourceKey = "other";
  await expect(prepareManagedRoutineContext(c.ctx, r.plugin, r.routine)).rejects.toThrow(); expect(c.patch).not.toHaveBeenCalled();
});
it.each(["foreign-reader", "denied-reader", "changed-routine", "new-run", "wrong-ceo", "existing-message", "existing-description"])("rejects %s instead of claiming prequery visibility", async kind => {
  const r = resources(), c = context(); reads.routine = structuredClone(r.routine);
  if (kind === "foreign-reader") reads.routine = { ...r.routine, companyId: "foreign" };
  if (kind === "denied-reader") reads.status = 403;
  if (kind === "changed-routine") reads.routine = { ...r.routine, status: "active" };
  if (kind === "new-run") c.lateRun();
  if (kind === "wrong-ceo") c.source.assigneeAgentId = "other";
  if (kind === "existing-message") vi.mocked(c.ctx.input.api.get).mockImplementation(async (url: string) => url.endsWith("/comments") ? [{ id: "prior-comment" }] : c.source);
  if (kind === "existing-description") c.source.description = "Prior context";
  await expect(prepareManagedRoutineContext(c.ctx, r.plugin, r.routine)).rejects.toThrow(); expect(c.evidence).not.toHaveBeenCalled();
});
