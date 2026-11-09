import { expect, it } from "vitest";
import { searchRunnerApi } from "../services/native-runtime/runner-api-catalog.js";
import { CASES_CHAT_DIRECTIVE } from "../services/agent-conversations.js";

// Queries a chat agent issued in a failed case-history eval: the case reads
// had generated "GET cases events" summaries, so none reached the first page
// and the agent answered from task documents alone.
const firstPage = (query: string) => searchRunnerApi({ query }).results.map(row => row.operationId);

it("finds a task's case and the case audit history on the first search page", () => {
  expect(firstPage("list company cases")).toContain("GET /api/companies/{companyId}/cases");
  expect(firstPage("cases list facts history")).toContain("GET /api/cases/{id}/events");
  expect(firstPage("case facts update history change log audit")).toContain("GET /api/cases/{id}/events");
  expect(firstPage("case for task")).toContain("GET /api/issues/{issueId}/cases");
  const events = searchRunnerApi({ query: "GET /api/cases/{id}/events" }).results[0]!;
  expect(events.description).toMatch(/fields_changed/);
  expect(events.description).toMatch(/does not retain the previous fact values/);
});

it("tells chat agents where a task's case and its fact-change history are", () => {
  expect(CASES_CHAT_DIRECTIVE).toContain("GET /api/issues/{issueId}/cases");
  expect(CASES_CHAT_DIRECTIVE).toContain("GET /api/cases/{id}/events");
});
