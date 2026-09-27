import { describe, expect, it } from "vitest";
import { apiResponseReadingTask, responseEvidenceCode, responseEvidenceDescription, successfulApiReadCount } from "./api-response-reading.js";

describe("large API response evidence fixture", () => {
  it("keeps evidence beyond both preview and inline limits and out of the assignment", () => {
    const source = responseEvidenceDescription("fixture");
    const code = responseEvidenceCode("fixture");
    expect(Buffer.byteLength(source)).toBeGreaterThan(24 * 1024);
    expect(source.indexOf(code)).toBeGreaterThan(24 * 1024);
    expect(apiResponseReadingTask.buildPrompt("fixture")).not.toContain(code);
    expect(apiResponseReadingTask.buildPrompt("fixture")).toContain("responseText.nextOffsetBytes");
  });
  it("counts only real completed API tool events, never narrative claims or missing evidence", () => {
    const event = { eventType: "tool.execution.completed", payload: { prpEvent: { payload: { name: "call_api", status: "completed" } } } };
    expect(successfulApiReadCount([event])).toBe(1);
    expect(successfulApiReadCount([])).toBe(0);
    expect(successfulApiReadCount([{ ...event, eventType: "item.delta" }, { ...event, payload: null }, { ...event, payload: { prpEvent: { payload: { name: "call_api", status: "failed" } } } }])).toBe(0);
  });
});
