import { describe, expect, it, vi } from "vitest";
import { chatRunEvidenceApi, createOwnedChatRunEvidenceObserver, readChatRuns } from "./chat-run-evidence-observer.js";
import type { ChatFlowInput } from "./chat-flow.js";
const companyId = "11111111-1111-4111-8111-111111111111", runId = "22222222-2222-4222-8222-222222222222", foreign = "33333333-3333-4333-8333-333333333333";
function fixture() {
  const row = { id: runId, companyId, agentId: "worker", status: "succeeded" };
  const owner = { baseURL: "http://127.0.0.1:3100", get: vi.fn(async () => ({ content: "actual owned log" })),
    getRunObservation: vi.fn(async (path: string): Promise<unknown> => path.includes("/companies/") ? [row] : path.includes("/events?") ? [] : row) };
  const observer = createOwnedChatRunEvidenceObserver(owner as Parameters<typeof createOwnedChatRunEvidenceObserver>[0], companyId);
  const actor = { baseURL: owner.baseURL, get: vi.fn(async () => { throw Object.assign(new Error("Private source denied"), { status: 403 }); }), getRunObservation: vi.fn(async (path: string): Promise<unknown> => path.includes("/companies/") ? [row] : row) };
  const input = { api: actor, fixtures: { company: { id: companyId } }, execution: { suite: { id: "chat-features" }, task: { id: "activity.agent-feedback" } }, ownedRunEvidenceObserver: observer } as unknown as ChatFlowInput;
  return { owner, observer, row, actor, input };
}
describe("exact commentary case independent run evidence", () => {
  it("uses the privately frozen owner only for GET evidence, preserving the actual product actor", async () => {
    const f = fixture(); expect(await readChatRuns(f.input)).toEqual([f.row]);
    await f.observer.getRunObservation(`/api/heartbeat-runs/${runId}/events?afterSeq=0&limit=1000`);
    await f.observer.get(`/api/heartbeat-runs/${runId}/log?limitBytes=1048576`);
    expect(f.owner.get).toHaveBeenCalledExactlyOnceWith(`/api/heartbeat-runs/${runId}/log?limitBytes=1048576`);
    expect(f.actor.getRunObservation).not.toHaveBeenCalled(); expect(f.input.api).toBe(f.actor);
    await expect(f.input.api.get(`/api/issues/${foreign}`)).rejects.toMatchObject({ status: 403 });
    expect(Object.keys(f.observer).sort()).toEqual(["companyId", "origin", "listRuns", "get", "getRunObservation"].sort());
    expect(Object.isFrozen(f.observer)).toBe(true);
  });
  it("keeps ordinary/default run collection on the unchanged product API", async () => {
    const f = fixture(); delete f.input.ownedRunEvidenceObserver;
    expect(chatRunEvidenceApi(f.input)).toBe(f.actor); expect(await readChatRuns(f.input)).toEqual([f.row]);
    expect(f.owner.getRunObservation).not.toHaveBeenCalled();
  });
  it.each(["scenario", "company", "origin"]) ("rejects an observer borrowed into another %s", kind => {
    const f = fixture();
    if (kind === "scenario") f.input.execution.task.id = "activity.work-timeline";
    if (kind === "company") f.input.fixtures.company.id = foreign;
    if (kind === "origin") Object.assign(f.actor, { baseURL: "https://other.test" });
    expect(() => chatRunEvidenceApi(f.input)).toThrow("exact approved scenario/company/origin");
  });
  it("rejects a run not independently listed in the owned company", async () => {
    const f = fixture(); await expect(f.observer.get(`/api/heartbeat-runs/${runId}`)).rejects.toThrow("independently listed");
    await f.observer.listRuns(); await expect(f.observer.get(`/api/heartbeat-runs/${foreign}`)).rejects.toThrow("independently listed");
  });
  it.each(["https://foreign.test/api/heartbeat-runs/", "/api/issues/", "/api/heartbeat-runs/"]) ("rejects unauthorized origin/path %s", async prefix => {
    const f = fixture(); await f.observer.listRuns();
    const path = prefix + runId + (prefix === "/api/heartbeat-runs/" ? "/cancel" : "");
    await expect(f.observer.get(path)).rejects.toThrow();
  });
  it("rejects foreign/duplicate company listings and mismatched detail identity", async () => {
    const f = fixture(); f.row.companyId = foreign; await expect(f.observer.listRuns()).rejects.toThrow("foreign");
    const duplicate = fixture(); duplicate.owner.getRunObservation.mockResolvedValue([duplicate.row, duplicate.row]);
    await expect(duplicate.observer.listRuns()).rejects.toThrow("duplicate");
    const wrong = fixture(); await wrong.observer.listRuns(); wrong.row.companyId = foreign;
    await expect(wrong.observer.get(`/api/heartbeat-runs/${runId}`)).rejects.toThrow("owned list identity");
  });
  it.each(["/events?afterSeq=0&limit=5&mutation=1", "/log?limitBytes=99999999", "?includeSecrets=1", "/events?afterSeq=0&limit=5#fragment"])("rejects unauthorized evidence query %s", async suffix => {
    const f = fixture(); await f.observer.listRuns(); await expect(f.observer.get(`/api/heartbeat-runs/${runId}${suffix}`)).rejects.toThrow();
  });
});
