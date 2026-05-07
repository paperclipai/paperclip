import { describe, expect, it } from "vitest";
import { ToscaCloudClient } from "../../client.js";
import {
  firstCallUrl,
  mockJsonResponse,
  mockNoContentResponse,
} from "../helpers.js";
import executionsFixture from "../../../fixtures/executions.json" with { type: "json" };

const BASE_URL = "https://myorg.tricentis.com";
const CREDS = { type: "pat" as const, token: "test-token" };

function makeClient(fetchFn: typeof globalThis.fetch): ToscaCloudClient {
  return new ToscaCloudClient({ baseUrl: BASE_URL, credentials: CREDS, fetchFn });
}

describe("ExecutionsResource", () => {
  it("lists executions for a workspace", async () => {
    const fetch = mockJsonResponse(executionsFixture.list);
    const client = makeClient(fetch);
    const page = await client.executions.list("ws-001");
    expect(page.items).toHaveLength(2);
    expect(firstCallUrl(fetch)).toContain("/api/v1/workspaces/ws-001/executions");
  });

  it("gets a single execution with results", async () => {
    const fetch = mockJsonResponse(executionsFixture.get);
    const client = makeClient(fetch);
    const exec = await client.executions.get("ws-001", "exec-001");
    expect(exec.id).toBe("exec-001");
    expect(exec.status).toBe("passed");
    expect(exec.results).toHaveLength(2);
    expect(exec.results[0]!.error).toBeNull();
  });

  it("creates an execution with specified test cases", async () => {
    const fetch = mockJsonResponse(executionsFixture.create, 201);
    const client = makeClient(fetch);
    const exec = await client.executions.create("ws-001", {
      projectId: "proj-001",
      testCaseIds: ["tc-001"],
    });
    expect(exec.id).toBe("exec-003");
    expect(exec.status).toBe("pending");
    expect(exec.results).toHaveLength(0);
  });

  it("cancels a running execution", async () => {
    const fetch = mockJsonResponse(executionsFixture.cancel);
    const client = makeClient(fetch);
    const exec = await client.executions.cancel("ws-001", "exec-003", {
      reason: "Test cancelled by engineer",
    });
    expect(exec.status).toBe("cancelled");
    expect(firstCallUrl(fetch)).toContain(
      "/api/v1/workspaces/ws-001/executions/exec-003/cancel",
    );
  });

  it("reflects failed execution results including error message", async () => {
    const fetch = mockJsonResponse(executionsFixture.list);
    const client = makeClient(fetch);
    const page = await client.executions.list("ws-001");
    const failed = page.items.find((e) => e.status === "failed");
    expect(failed).toBeDefined();
    expect(failed!.results[0]!.error).toBe("Element not found: #submit-btn");
  });

  it("deletes an execution (204)", async () => {
    const fetch = mockNoContentResponse();
    const client = makeClient(fetch);
    await expect(
      client.executions.delete("ws-001", "exec-001"),
    ).resolves.toBeUndefined();
  });
});
