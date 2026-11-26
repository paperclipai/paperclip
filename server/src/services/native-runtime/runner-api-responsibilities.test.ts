import { describe, expect, it } from "vitest";
import { runnerApiOperation } from "./runner-api-catalog.js";
import { runnerApiUrl, validateRunnerApiCall } from "./runner-api-client.js";

const context = {
  companyId: "company-a",
  issueId: "issue-a",
  issueIdentifier: "API-1",
  runId: "run-a",
  workMode: "standard",
};

describe("runner API catalog for responsibilities", () => {
  it("lets an agent call the responsibilities routes through call_api", () => {
    for (const operationId of [
      "GET /api/companies/{companyId}/responsibilities",
      "POST /api/companies/{companyId}/responsibilities",
      "PATCH /api/responsibilities/{id}",
      "POST /api/responsibilities/{id}/links",
    ]) {
      const operation = runnerApiOperation(operationId);
      expect(operation.transport, operationId).toBe("rest");
      expect(operation.allowedModes, operationId).toContain("standard");
      expect(operation.authorization, operationId).toEqual({ actor: "board_or_agent" });
    }
    const { input } = validateRunnerApiCall({
      operationId: "GET /api/companies/{companyId}/responsibilities",
      query: { ownerUserId: "user-1" },
    }, context);
    expect(runnerApiUrl(runnerApiOperation(input.operationId), input, context, "http://127.0.0.1:3100").href)
      .toBe("http://127.0.0.1:3100/api/companies/company-a/responsibilities?ownerUserId=user-1");
    expect(() => validateRunnerApiCall({
      operationId: "POST /api/companies/{companyId}/responsibilities",
      body: { ownerUserId: "user-1", title: "Fundraising" },
    }, { ...context, workMode: "ask" })).toThrow(/only reads/);
  });

  it("lets the agent in a bar conversation propose a bar through call_api, and keeps accepting for people", () => {
    const operation = runnerApiOperation("POST /api/issues/{id}/bar-proposals");
    expect(operation.transport).toBe("rest");
    expect(operation.allowedModes).toContain("standard");
    expect(operation.authorization).toEqual({ actor: "board_or_agent" });
    for (const operationId of [
      "POST /api/issues/{id}/bar-proposals/{interactionId}/accept",
      "POST /api/issues/{id}/bar-proposals/{interactionId}/decline",
      "POST /api/responsibilities/{id}/bar-conversation",
    ]) expect(runnerApiOperation(operationId).authorization, operationId).toEqual({ actor: "board" });
  });
});
