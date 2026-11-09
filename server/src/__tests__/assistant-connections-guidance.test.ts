import { expect, it } from "vitest";
import { searchRunnerApi } from "../services/native-runtime/runner-api-catalog.js";
import { validateRunnerApiCall } from "../services/native-runtime/runner-api-client.js";

const context = { companyId: "00000000-0000-4000-8000-000000000121", issueId: "00000000-0000-4000-8000-000000000122", runId: "00000000-0000-4000-8000-000000000123", workMode: "standard" };

it("tells agents searching for assistant disconnection that only the person can do it, and where", () => {
  // The queries a chat agent used while looking for a way to disconnect a person's old assistant.
  for (const query of ["chat client assistant disconnect connection", "assistant connections revoke list", "mcp connection revoke REST"]) {
    const found = searchRunnerApi({ query, limit: 10 }).results;
    const revoke = found.find(row => row.operationId === "DELETE /api/mcp/connections/{id}");
    expect(revoke, query).toBeDefined();
    expect(revoke!.description).toContain("[Assistant connections](/<prefix>/apps/assistant-connection)");
    expect(revoke!.description).toContain("only the signed-in person");
    expect(revoke!.description).toContain("do not search for one");
    expect(revoke!.description).toMatch(/already created keep their assignees and running work/);
  }
  const list = searchRunnerApi({ query: "GET /api/mcp/connections" }).results[0]!;
  expect(list.description).toContain("[Assistant connections](/<prefix>/apps/assistant-connection)");
});

it("says the call_api protocol rejection is final instead of inviting another search", () => {
  expect(() => validateRunnerApiCall({ operationId: "GET /api/mcp/connections" }, context))
    .toThrow(/no other API route substitutes for it\. Its catalog description says who can use it\./);
});
