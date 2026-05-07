import { describe, expect, it } from "vitest";
import { ToscaCloudClient } from "../../client.js";
import {
  firstCallUrl,
  mockJsonResponse,
  mockNoContentResponse,
} from "../helpers.js";
import projectsFixture from "../../../fixtures/projects.json" with { type: "json" };

const BASE_URL = "https://myorg.tricentis.com";
const CREDS = { type: "pat" as const, token: "test-token" };

function makeClient(fetchFn: typeof globalThis.fetch): ToscaCloudClient {
  return new ToscaCloudClient({ baseUrl: BASE_URL, credentials: CREDS, fetchFn });
}

describe("ProjectsResource", () => {
  it("lists projects for a workspace", async () => {
    const fetch = mockJsonResponse(projectsFixture.list);
    const client = makeClient(fetch);
    const page = await client.projects.list("ws-001");
    expect(page.items).toHaveLength(2);
    expect(page.items[0]!.workspaceId).toBe("ws-001");
    expect(firstCallUrl(fetch)).toContain("/api/v1/workspaces/ws-001/projects");
  });

  it("gets a single project", async () => {
    const fetch = mockJsonResponse(projectsFixture.get);
    const client = makeClient(fetch);
    const proj = await client.projects.get("ws-001", "proj-001");
    expect(proj.id).toBe("proj-001");
    expect(proj.workspaceId).toBe("ws-001");
  });

  it("creates a project", async () => {
    const fetch = mockJsonResponse(projectsFixture.create, 201);
    const client = makeClient(fetch);
    const proj = await client.projects.create("ws-001", { name: "New Project" });
    expect(proj.id).toBe("proj-003");
  });

  it("updates a project", async () => {
    const updated = { ...projectsFixture.get, name: "Renamed" };
    const fetch = mockJsonResponse(updated);
    const client = makeClient(fetch);
    const proj = await client.projects.update("ws-001", "proj-001", { name: "Renamed" });
    expect(proj.name).toBe("Renamed");
  });

  it("deletes a project (204)", async () => {
    const fetch = mockNoContentResponse();
    const client = makeClient(fetch);
    await expect(client.projects.delete("ws-001", "proj-001")).resolves.toBeUndefined();
  });
});
