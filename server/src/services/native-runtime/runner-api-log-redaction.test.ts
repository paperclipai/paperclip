import { describe, expect, it } from "vitest";
import { redactRunnerApiEvent, redactRunnerApiPayloads } from "./runner-api-log-redaction.js";

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
  it.each(["call_api", "create_case"])("keeps %s denial metadata out of the API-body exception", operationId => {
    const payload = {
      provider: "codex", operationId, callId: "schema-denied", code: "semantic_tool_denied",
      paperclipExecuted: false, message: "Provider arguments failed JSON Schema validation.",
      inputSchemaGuidance: "Invalid tool arguments. Check these input schema locations: /properties/title/type.",
    };
    const event = { sourceKind: "runner", eventType: "harness.diagnostic", payload };
    expect(redactRunnerApiEvent(event)).toEqual(event);
    const debugEvent = { ...event, debug: { operationId, data: { value: "private-debug-value" } } };
    const savedDebug = redactRunnerApiEvent(debugEvent);
    expect(savedDebug.payload).toEqual(payload);
    expect(savedDebug.debug).toMatchObject({ apiPayloadRedacted: true });
    expect(JSON.stringify(savedDebug)).not.toContain("private-debug-value");
    expect(redactRunnerApiEvent(savedDebug)).toEqual(savedDebug);
    for (const value of [
      { ...event, eventType: "item.completed" },
      { ...event, sourceKind: "control_plane" },
      { ...event, payload: { ...payload, arguments: { value: "private-fixture-value" } } },
      { ...event, payload: { ...payload, inputSchemaGuidance: "x".repeat(513) } },
      { ...event, payload: { ...payload, inputSchemaGuidance: "unsafe\nmetadata" } },
      { ...event, payload: { ...payload, inputSchemaGuidance: { value: "private-fixture-value" } } },
    ]) {
      const saved = redactRunnerApiEvent(value);
      expect(saved.payload).toMatchObject({ apiPayloadRedacted: true });
      expect(saved.payload).not.toHaveProperty("inputSchemaGuidance");
      expect(JSON.stringify(saved)).not.toContain("private-fixture-value");
    }
    const nested = { sourceKind: "runner", eventType: "item.completed", payload: {
      operationId, data: { ...event, payload: { ...payload, inputSchemaGuidance: "private-fixture-value" } },
    } };
    expect(JSON.stringify(redactRunnerApiEvent(nested))).not.toContain("private-fixture-value");
    expect(redactRunnerApiPayloads(payload)).not.toHaveProperty("inputSchemaGuidance");
  });
  it("omits malformed API arguments and semantic result envelopes", () => {
    const value = { item: { type: "tool_use", name: "call_api", input: { operationId: "invalid", body: { value: "private-fixture-value" } } },
      result: { operationId: "call_api", result: { data: "private-fixture-value" } } };
    expect(JSON.stringify(redactRunnerApiPayloads(value))).not.toContain("private-fixture-value");
    expect(redactRunnerApiPayloads(redactRunnerApiPayloads(value))).toEqual(redactRunnerApiPayloads(value));
  });
  it.each(["create_case", "read_case", "update_case", "read_case_document", "write_case_document"])("keeps %s data on the wire while redacting persisted input and output", name => {
    const value = {
      item: { type: "tool_use", name, input: { caseId: "private-case", fields: { customer: "private-customer" }, body: "private-body", kickoff: { instructions: "private-kickoff" }, initialDocuments: [{ key: "brief", title: "Brief", body: "private-document" }] } },
      result: { operationId: name, result: { data: { fields: { customer: "private-customer" } } } },
    };
    const saved = redactRunnerApiPayloads(value);
    expect(JSON.stringify(saved)).not.toMatch(/private-case|private-customer|private-body|private-kickoff|private-document/);
    expect(saved.item.input).toMatchObject({ apiPayloadRedacted: true, apiPayloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(value.item.input.body).toBe("private-body");
    expect(redactRunnerApiPayloads(saved)).toEqual(saved);
  });
});
