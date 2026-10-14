import { describe, expect, it } from "vitest";
import { redactRunnerApiPayloads } from "./runner-api-log-redaction.js";

describe("API payload persistence redaction", () => {
  it.each(["POST /api/agents/me/secrets/{key}/value", "POST /api/companies/{companyId}/exports", "GET /api/projects/{id}"])("preserves private HTTP results on the wire, but omits %s from history", operationId => {
    const result = { operationId: "call_api", apiOperationId: operationId, status: 200, ok: true, data: { value: "private-fixture-value" } };
    const event = { item: { type: "tool_result", result } };
    const saved = redactRunnerApiPayloads(event);
    expect(saved.item.result).toMatchObject({ operationId: "call_api", apiOperationId: operationId, status: 200, apiPayloadRedacted: true });
    expect(JSON.stringify(saved)).not.toContain("private-fixture-value");
    expect(event.item.result.data.value).toBe("private-fixture-value");
    expect(redactRunnerApiPayloads(event)).toEqual(saved);
    expect(redactRunnerApiPayloads(saved)).toEqual(saved);
    expect((redactRunnerApiPayloads({ ...result, data: { value: "another-fixture-value" } }) as any).apiPayloadSha256)
      .not.toBe((saved.item.result as any).apiPayloadSha256);
  });
  it("redacts serialized legacy receipts and API request arguments", () => {
    const value = { text: JSON.stringify({ result: { operationId: "POST /api/agents/me/secrets/{key}/value", data: { value: "private-fixture-value" } } }),
      input: { operationId: "POST /api/agents/me/secret-proposals", body: { value: "proposal-fixture-value" } } };
    const saved = redactRunnerApiPayloads(value);
    expect(JSON.stringify(saved)).not.toContain("private-fixture-value");
    expect(JSON.stringify(saved)).not.toContain("proposal-fixture-value");
    expect(JSON.parse(saved.text).result.apiPayloadRedacted).toBe(true);
  });
  it("preserves unrelated tool output and JSON text formatting", () => {
    const value = { result: { operationId: "get_task_context", data: { title: "Work" } }, text: '{ "ordinary": "output" }' };
    expect(redactRunnerApiPayloads(value)).toEqual(value);
  });
  it("omits malformed API arguments and semantic result envelopes", () => {
    const value = { item: { type: "tool_use", name: "call_api", input: { operationId: "invalid", body: { value: "private-fixture-value" } } },
      result: { operationId: "call_api", result: { data: "private-fixture-value" } } };
    expect(JSON.stringify(redactRunnerApiPayloads(value))).not.toContain("private-fixture-value");
    expect(redactRunnerApiPayloads(redactRunnerApiPayloads(value))).toEqual(redactRunnerApiPayloads(value));
  });
});
