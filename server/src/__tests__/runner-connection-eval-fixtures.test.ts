import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

describe("connection eval real-server fixtures", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    server = await startRunnerApiTestServer();
  }, 60_000);
  afterAll(async () => { await server?.close(); vi.unstubAllEnvs(); });
  const call = (fixture: Awaited<ReturnType<typeof server.fixture>>, tool: string, args: unknown) => fixture.authority.execute({ tool, callId: randomUUID(), arguments: args });

  it("binds fresh discovery and card creation to an authenticated responsible user", async () => {
    const fixture = await server.fixture({ connectionScenario: "fresh" });
    expect((await fixture.snapshot()).connectionInteractions).toEqual([]);
    expect(await call(fixture, "connections_search", { query: "Notion" })).toMatchObject({ results: [{ service: "notion", state: "available" }] });
    await call(fixture, "connection_request", { service: "notion" });
    const state = await fixture.snapshot();
    expect(state.connectionInteractions).toEqual([expect.objectContaining({ addresseeUserId: fixture.responsibleUserId, sourceRunId: fixture.runId, status: "pending", payload: expect.objectContaining({ requestingAgentId: fixture.agentId }) })]);
    expect(state.connections).toEqual([]);
  });

  it("reuses a pending card from a previous run and preserves a declined outcome", async () => {
    const pending = await server.fixture({ connectionScenario: "pending" });
    expect(await call(pending, "connection_request", { service: "notion" })).toMatchObject({ interactionId: pending.pendingInteractionId });
    expect((await pending.snapshot()).connectionInteractions).toHaveLength(1);
    expect((await pending.snapshot()).connectionInteractions[0]!.sourceRunId).not.toBe(pending.runId);
    const declined = await server.fixture({ connectionScenario: "declined" });
    await expect(call(declined, "connection_request", { service: "notion" })).rejects.toThrow("declined");
    const state = await declined.snapshot();
    expect(state.connectionInteractions).toEqual([expect.objectContaining({ id: declined.pendingInteractionId, status: "rejected" })]);
    expect(state.connectionIntentDeliveries).toHaveLength(1);
  });

  it("discovers authorized indexed custom metadata without fetching the inert provider", async () => {
    const fixture = await server.fixture({ connectionScenario: "custom" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected provider call"));
    try {
      expect(await call(fixture, "connections_search", { query: "heliotrope" })).toMatchObject({ results: [{ service: fixture.customConnectionService, state: "needs_user_action", source: "configured" }] });
      await call(fixture, "connection_request", { service: fixture.customConnectionService });
      expect(fetchSpy).not.toHaveBeenCalled();
      const state = await fixture.snapshot();
      expect(state.installs).toEqual([]);
      expect(state.connectionInteractions).toHaveLength(1);
      expect(JSON.stringify(state.connections)).not.toContain("transportConfig");
    } finally { fetchSpy.mockRestore(); }
  });

  it("hides foreign connections and denies stale ownership", async () => {
    const foreign = await server.fixture({ connectionScenario: "foreign" });
    expect(await call(foreign, "connections_search", { query: "heliotrope" })).toMatchObject({ results: [] });
    await expect(call(foreign, "connection_request", { service: foreign.foreignConnectionService })).rejects.toThrow("not found");
    expect((await foreign.snapshot()).connectionInteractions).toEqual([]);
    const stale = await server.fixture({ connectionScenario: "stale_owner" });
    await expect(call(stale, "connection_request", { service: "notion" })).rejects.toThrow();
    expect((await stale.snapshot()).connectionInteractions).toEqual([]);
  });

  it("reports installed and permitted fixture Notion as ready without a card", async () => {
    const fixture = await server.fixture({ connectionScenario: "ready" });
    expect(await call(fixture, "connections_search", { query: "Notion" })).toMatchObject({ results: [{ service: "notion", state: "ready" }] });
    expect(await call(fixture, "connection_request", { service: "notion" })).toMatchObject({ state: "ready", interactionId: null });
    expect((await fixture.snapshot()).connectionInteractions).toEqual([]);
  });

  it("resets paired attempts without carrying prior connections and rejects unknown scenarios", async () => {
    const first = await server.fixture({ connectionScenario: "ready", reset: true });
    const second = await server.fixture({ connectionScenario: "fresh", reset: true });
    expect(second.responsibleUserId).toBe(first.responsibleUserId);
    expect(second.companyId).toBe(first.companyId);
    expect((await second.snapshot()).connections).toEqual([]);
    await expect(server.fixture({ connectionScenario: "unknown" as never })).rejects.toThrow("Unknown connection eval scenario");
  });
});
