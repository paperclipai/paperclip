import { expect, it } from "vitest";
import { searchRunnerApi } from "../services/native-runtime/runner-api-catalog.js";

it.each([
  ["routine webhook trigger", "POST /api/routines/{id}/triggers"],
  ["rotate routine trigger secret", "POST /api/routine-triggers/{id}/rotate-secret"],
])("search %j tells the agent to keep the webhook secret out of chat and where the person reveals it", (query, operationId) => {
  const operation = searchRunnerApi({ query, limit: 10 }).results.find(row => row.operationId === operationId);
  expect(operation, query).toBeDefined();
  const description = operation!.description;
  expect(description).toContain("never write its value, or a header containing it, in a chat reply");
  expect(description).toContain("/<prefix>/routines/<routineId>/triggers, as a Markdown link");
  expect(description).toContain("/<prefix>/routines/<routineId>/triggers?triggerSetup=<triggerId> and tell them to choose Generate new key");
  expect(description).toContain("Edit webhook, then Replace key");
  expect(description).toContain("With signingMode none the URL alone starts the routine, so treat that URL as a credential too");
});
