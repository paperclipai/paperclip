import { describe, expect, it } from "vitest";
import { ToscaCloudClient } from "../../client.js";
import {
  firstCallUrl,
  mockJsonResponse,
  mockNoContentResponse,
} from "../helpers.js";
import testCasesFixture from "../../../fixtures/test-cases.json" with { type: "json" };

const BASE_URL = "https://myorg.tricentis.com";
const CREDS = { type: "pat" as const, token: "test-token" };

function makeClient(fetchFn: typeof globalThis.fetch): ToscaCloudClient {
  return new ToscaCloudClient({ baseUrl: BASE_URL, credentials: CREDS, fetchFn });
}

describe("TestCasesResource", () => {
  it("lists test cases for a project", async () => {
    const fetch = mockJsonResponse(testCasesFixture.list);
    const client = makeClient(fetch);
    const page = await client.testCases.list("ws-001", "proj-001");
    expect(page.items).toHaveLength(3);
    expect(firstCallUrl(fetch)).toContain(
      "/api/v1/workspaces/ws-001/projects/proj-001/testcases",
    );
  });

  it("identifies deprecated test cases in the list", async () => {
    const fetch = mockJsonResponse(testCasesFixture.list);
    const client = makeClient(fetch);
    const page = await client.testCases.list("ws-001", "proj-001");
    const deprecated = page.items.filter((tc) => tc.status === "deprecated");
    expect(deprecated).toHaveLength(1);
    expect(deprecated[0]!.id).toBe("tc-003");
  });

  it("gets a single test case", async () => {
    const fetch = mockJsonResponse(testCasesFixture.get);
    const client = makeClient(fetch);
    const tc = await client.testCases.get("ws-001", "proj-001", "tc-001");
    expect(tc.id).toBe("tc-001");
    expect(tc.status).toBe("active");
    expect(tc.tags).toContain("smoke");
  });

  it("creates a test case", async () => {
    const fetch = mockJsonResponse(testCasesFixture.create, 201);
    const client = makeClient(fetch);
    const tc = await client.testCases.create("ws-001", "proj-001", {
      name: "Password Reset",
      tags: ["auth"],
    });
    expect(tc.id).toBe("tc-004");
    expect(tc.status).toBe("active");
  });

  it("updates a test case status to deprecated", async () => {
    const updated = { ...testCasesFixture.get, status: "deprecated" as const };
    const fetch = mockJsonResponse(updated);
    const client = makeClient(fetch);
    const tc = await client.testCases.update("ws-001", "proj-001", "tc-001", {
      status: "deprecated",
    });
    expect(tc.status).toBe("deprecated");
  });

  it("deletes a test case (204)", async () => {
    const fetch = mockNoContentResponse();
    const client = makeClient(fetch);
    await expect(
      client.testCases.delete("ws-001", "proj-001", "tc-001"),
    ).resolves.toBeUndefined();
  });
});
