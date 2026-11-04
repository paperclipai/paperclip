import { randomUUID } from "node:crypto";
import { request } from "@playwright/test";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { RunnerApi } from "../../../tests/runner-e2e/api.js";
import { setupAggregatorFixture } from "../../../tests/runner-e2e/aggregator-fixture.js";

let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
beforeAll(async () => {
  vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
  server = await startRunnerApiTestServer({ deploymentMode: "local_trusted" });
  vi.stubEnv("PAPERCLIP_RUNNER_E2E_PORT", new URL(server.apiUrl).port);
}, 60_000);
afterAll(async () => { await server?.close(); vi.unstubAllEnvs(); });

it("sets up an indexed company gateway without granting the eval agent access", async () => {
  const fixture = await server.fixture({ connectionScenario: "fresh", disableWakeOnDemand: true });
  const context = await request.newContext({ baseURL: server.apiUrl, extraHTTPHeaders: { Origin: server.apiUrl } });
  const api = new RunnerApi(context);
  let gateway: Awaited<ReturnType<typeof setupAggregatorFixture>> | undefined;
  try {
    gateway = await setupAggregatorFixture(api, fixture.companyId, fixture.agentId, "CONTACTS_local_only", true);
    expect(gateway.initialAccess).toEqual({ installed: false, allowedToolIds: [] });
    expect(gateway.invocationCount()).toBe(0);
    const discovery = await fixture.authority.execute({ tool: "connections_search", callId: randomUUID(), arguments: { query: "HubSpot" } });
    expect(discovery).toMatchObject({ providerQuestion: { id: "connection-provider:hubspot" }, providerQuestionSet: { schema: "paperclip.question_set.v1" } });
    await expect(fixture.authority.execute({ tool: "connection_request", callId: randomUUID(), arguments: { service: "via:arcade:hubspot" } })).rejects.toThrow();
    expect(gateway.invocationCount()).toBe(0);
  } finally { await gateway?.close(); await context.dispose(); }
}, 60_000);
