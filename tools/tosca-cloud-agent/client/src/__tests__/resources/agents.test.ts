import { describe, expect, it } from "vitest";
import { ToscaCloudClient } from "../../client.js";
import { firstCallUrl, mockJsonResponse } from "../helpers.js";
import agentsFixture from "../../../fixtures/agents.json" with { type: "json" };

const BASE_URL = "https://myorg.tricentis.com";
const CREDS = { type: "pat" as const, token: "test-token" };

function makeClient(fetchFn: typeof globalThis.fetch): ToscaCloudClient {
  return new ToscaCloudClient({ baseUrl: BASE_URL, credentials: CREDS, fetchFn });
}

describe("AgentsResource", () => {
  it("lists all agents", async () => {
    const fetch = mockJsonResponse(agentsFixture.list);
    const client = makeClient(fetch);
    const page = await client.agents.list();
    expect(page.items).toHaveLength(2);
    expect(firstCallUrl(fetch)).toContain("/api/v1/agents");
  });

  it("gets a single agent", async () => {
    const fetch = mockJsonResponse(agentsFixture.get);
    const client = makeClient(fetch);
    const agent = await client.agents.get("agent-001");
    expect(agent.id).toBe("agent-001");
    expect(agent.status).toBe("online");
    expect(agent.capabilities).toContain("sap");
  });

  it("lists agents scoped to a workspace", async () => {
    const fetch = mockJsonResponse(agentsFixture.listForWorkspace);
    const client = makeClient(fetch);
    const page = await client.agents.listForWorkspace("ws-001");
    expect(page.items).toHaveLength(1);
    expect(firstCallUrl(fetch)).toContain("/api/v1/workspaces/ws-001/agents");
  });

  it("identifies busy agents in the list", async () => {
    const fetch = mockJsonResponse(agentsFixture.list);
    const client = makeClient(fetch);
    const page = await client.agents.list();
    const busyAgents = page.items.filter((a) => a.status === "busy");
    expect(busyAgents).toHaveLength(1);
    expect(busyAgents[0]!.id).toBe("agent-002");
  });
});
