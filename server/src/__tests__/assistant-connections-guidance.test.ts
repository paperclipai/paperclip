import { expect, it } from "vitest";
import { searchRunnerApi } from "../services/native-runtime/runner-api-catalog.js";
import { validateRunnerApiCall } from "../services/native-runtime/runner-api-client.js";

const context = { companyId: "00000000-0000-4000-8000-000000000121", issueId: "00000000-0000-4000-8000-000000000122", runId: "00000000-0000-4000-8000-000000000123", workMode: "standard" };

it("tells agents searching for assistant disconnection that only the person can do it, and where", () => {
  for (const query of ["chat client assistant disconnect connection", "assistant connections revoke list", "mcp connection revoke REST"]) {
    const found = searchRunnerApi({ query, limit: 10 }).results;
    const revoke = found.find(row => row.operationId === "DELETE /api/mcp/connections/{id}");
    expect(revoke, query).toBeDefined();
    expect(revoke!.description).toContain("[Assistant connections](/<prefix>/apps/assistant-connection)");
    expect(revoke!.description).toContain("only the signed-in person");
    expect(revoke!.description).toContain("Do not search for another route");
    expect(revoke!.description).toContain("OAuth token revocation sent by the connected assistant itself");
    expect(revoke!.description).toMatch(/already created keep their assignees and running work/);
  }
  const list = searchRunnerApi({ query: "GET /api/mcp/connections" }).results[0]!;
  expect(list.description).toContain("[Assistant connections](/<prefix>/apps/assistant-connection)");
});

it("says the call_api protocol rejection is final instead of inviting another search", () => {
  expect(() => validateRunnerApiCall({ operationId: "GET /api/mcp/connections" }, context))
    .toThrow(/no other API route substitutes for it\. Read its catalog description for details\./);
});

it("points at the catalog description only when the protocol endpoint has one", () => {
  const undocumented = searchRunnerApi({ query: "POST /api/mcp/project-tools" }).results.find(row => row.operationId === "POST /api/mcp/project-tools");
  expect(undocumented?.description).toBe("");
  let message = "";
  try { validateRunnerApiCall({ operationId: "POST /api/mcp/project-tools" }, context); } catch (error) { message = (error as Error).message; }
  expect(message).toContain("no other API route substitutes for it.");
  expect(message).not.toContain("catalog description");
});

it("does not claim a non-guidance protocol description says who can use the endpoint", () => {
  let message = "";
  try { validateRunnerApiCall({ operationId: "GET /api/companies/{companyId}/events/ws" }, context); } catch (error) { message = (error as Error).message; }
  expect(message).toContain("Read its catalog description for details.");
  expect(message).not.toContain("who can use it");
});
