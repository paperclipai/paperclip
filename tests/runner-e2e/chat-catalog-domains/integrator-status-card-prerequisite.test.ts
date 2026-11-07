import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
vi.mock("./internal-definition.js", () => ({ fixtureWorker: async () => ({ id: "worker" }) }));
// This fixture isolates the prerequisite-generation wait; the required-input
// recipe and later feature actions retain their separate owning controls.
vi.mock("./status-card-work-failure.js", async original => ({ ...await original<typeof import("./status-card-work-failure.js")>(), prepareCardChecklist: async () => undefined }));
vi.mock("../chat-query-attachments.js", async original => ({ ...await original<typeof import("../chat-query-attachments.js")>(), uploadFactualQueryAttachment: async () => ({ id: "fixture-attachment" }) }));
import { integratorStatusCardsCases } from "./integrator-status-cards.js";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const start = 10_000;
const keys = ["status-cards.explain-card", "status-cards.other-authors-card", "status-cards.refresh-card"] as const;
function fixture(key: string, deadline: number | undefined) {
  vi.useFakeTimers(); vi.setSystemTime(start);
  let readyAt = start + 190_000, cardState = "active", summary = "Payment approval blocks Launch.", generated = true, pending = false, late = false, runStatus = "succeeded", noWork = false, lateNative = false;
  const card = () => ({ id: "card", state: Date.now() >= readyAt ? cardState : "generating", summaryBody: Date.now() >= readyAt ? summary : null,
    lastGeneratedAt: generated ? "2026-11-03T01:00:00Z" : null, generatingIssueId: pending ? "generation" : null, fingerprint: {} });
  const get = vi.fn(async (path: string) => {
    if (path === "/api/instance/settings/experimental") return { enableStatusCards: false };
    if (path === "/api/status-cards/card") { if (late) vi.setSystemTime(deadline! + 1); return card(); }
    if (path.endsWith("/updates") || path.endsWith("/summary-revisions")) return [];
    throw Error("Unexpected fixture read");
  });
  const post = vi.fn(async (path: string) => {
    if (path.endsWith("/projects")) return { id: "project" };
    if (path.endsWith("/issues")) return { id: "source", companyId: "company", title: "Payment approval blocks launch", status: "blocked" };
    if (path.endsWith("/keys")) return { id: "owned-key", token: "synthetic-fixture-key" };
    if (path.endsWith("/budgets/policies")) return {};
    throw Error("Unexpected fixture write");
  });
  const remove = vi.fn(async () => ({})), patch = vi.fn(async () => ({ id: "source", companyId: "company", status: "done" }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ id: "card" }) })));
  const ctx = { scenario: { id: key }, observationDeadlineAt: deadline,
    input: { nonce: "synthetic", privateSecrets: [], fixtures: { company: { id: "company", issuePrefix: "ACORN" }, agent: { id: "ceo" } },
      api: { baseURL: "https://fixture.test", get, post, postSensitive: post, patch, delete: remove }, evidence: async () => {} },
    allRuns: async () => { if (lateNative) vi.setSystemTime(deadline! + 1); return noWork ? [] : [{ id: "prerequisite", status: runStatus }]; },
  } as unknown as ChatCatalogContext;
  const definition = integratorStatusCardsCases.find(row => row.scenarioId === key)!;
  const setup = () => definition.setup(ctx);
  const settle = async (ms: number) => {
    const result = setup().then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
    await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(ms); return result;
  };
  return { ctx, definition, setup, settle, get, remove, post, readyAt: (value: number) => { readyAt = value; },
    state: (value: string) => { cardState = value; }, summary: (value: string) => { summary = value; },
    generated: (value: boolean) => { generated = value; }, pending: () => { pending = true; }, late: () => { late = true; }, runStatus: (value: string) => { runStatus = value; }, noWork: () => { noWork = true; }, lateNative: () => { lateNative = true; } };
}
it.each(keys)("actual %s setup admits genuinely completed prerequisite after190s inside its original clock", async key => {
  const cap = key.endsWith("refresh-card") ? 1_200_000 : key.endsWith("explain-card") ? 720_000 : 540_000;
  const f = fixture(key, start + cap - 30_000), result = await f.settle(191_000);
  expect(result.error).toBeUndefined(); expect(result.value?.card).toMatchObject({ id: "card", state: "active" });
  expect(f.definition.attemptTimeoutMs).toBe(cap); expect(f.ctx.observationDeadlineAt).toBe(start + cap - 30_000);
  expect(f.remove).toHaveBeenCalledWith("/api/agents/" + (key.endsWith("other-authors-card") ? "worker" : "ceo") + "/keys/owned-key", { allowNotFound: true });
});
it.each([undefined, NaN, Infinity, start, start - 1])("rejects absent/invalid/expired original deadline %s", async deadline => {
  const f = fixture(keys[1], deadline); const result = await f.settle(181_000);
  expect(result.error).toBeInstanceOf(Error); expect(result.value).toBeUndefined();
});
it.each(["error", "missing summary", "missing generation", "still generating", "late await"])("rejects %s rather than accepting a partial prerequisite", async fault => {
  const f = fixture(keys[1], start + 1000); f.readyAt(start);
  if (fault === "error") f.state("error");
  if (fault === "missing summary") f.summary("");
  if (fault === "missing generation") f.generated(false);
  if (fault === "still generating") f.pending();
  if (fault === "late await") f.late();
  const result = await f.settle(3000); expect(result.error).toBeInstanceOf(Error); expect(result.value).toBeUndefined();
});
it.each(["failed", "cancelled", "timed_out"])("a completed card cannot hide actual native %s", async status => {
  const f = fixture(keys[1], start + 1000); f.readyAt(start); f.runStatus(status);
  const result = await f.settle(47_000); expect(result.error).toBeInstanceOf(Error); expect(result.value).toBeUndefined();
});
it("does not change the archive-card authored180s prerequisite phase", async () => {
  const f = fixture("status-cards.archive-card", start + 510_000); const result = await f.settle(181_000);
  expect(result.error?.message).toContain("actual prerequisite card generation"); expect(result.value).toBeUndefined();
});

it.each(["no actual run", "late native await"])("cannot treat %s as completed setup work", async fault => {
  const f = fixture(keys[1], start + 1000); f.readyAt(start);
  if (fault === "no actual run") f.noWork(); else f.lateNative();
  const result = await f.settle(3000); expect(result.error).toBeInstanceOf(Error); expect(result.value).toBeUndefined();
});
