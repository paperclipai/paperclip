import { describe, expect, it } from "vitest";
import { ToscaCloudClient } from "../../client.js";
import {
  firstCallUrl,
  mockJsonResponse,
  mockNoContentResponse,
} from "../helpers.js";
import workspacesFixture from "../../../fixtures/workspaces.json" with { type: "json" };

const BASE_URL = "https://myorg.tricentis.com";
const CREDS = { type: "pat" as const, token: "test-token" };

function makeClient(fetchFn: typeof globalThis.fetch): ToscaCloudClient {
  return new ToscaCloudClient({ baseUrl: BASE_URL, credentials: CREDS, fetchFn });
}

describe("WorkspacesResource", () => {
  it("lists workspaces", async () => {
    const fetch = mockJsonResponse(workspacesFixture.list);
    const client = makeClient(fetch);
    const page = await client.workspaces.list();
    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.id).toBe("ws-001");
    expect(firstCallUrl(fetch)).toContain("/api/v1/workspaces");
  });

  it("passes pagination params", async () => {
    const fetch = mockJsonResponse(workspacesFixture.list);
    const client = makeClient(fetch);
    await client.workspaces.list({ page: 2, pageSize: 5 });
    expect(firstCallUrl(fetch)).toContain("page=2");
    expect(firstCallUrl(fetch)).toContain("pageSize=5");
  });

  it("gets a single workspace", async () => {
    const fetch = mockJsonResponse(workspacesFixture.get);
    const client = makeClient(fetch);
    const ws = await client.workspaces.get("ws-001");
    expect(ws.id).toBe("ws-001");
    expect(ws.name).toBe("Itecor Workspace");
    expect(firstCallUrl(fetch)).toContain("/api/v1/workspaces/ws-001");
  });

  it("creates a workspace", async () => {
    const fetch = mockJsonResponse(workspacesFixture.create, 201);
    const client = makeClient(fetch);
    const ws = await client.workspaces.create({
      name: "New Workspace",
      description: "A freshly created workspace",
    });
    expect(ws.id).toBe("ws-003");
    expect(ws.name).toBe("New Workspace");
  });

  it("updates a workspace", async () => {
    const fetch = mockJsonResponse(workspacesFixture.update);
    const client = makeClient(fetch);
    const ws = await client.workspaces.update("ws-001", { name: "Updated Workspace" });
    expect(ws.name).toBe("Updated Workspace");
  });

  it("deletes a workspace (204)", async () => {
    const fetch = mockNoContentResponse();
    const client = makeClient(fetch);
    await expect(client.workspaces.delete("ws-001")).resolves.toBeUndefined();
  });
});
