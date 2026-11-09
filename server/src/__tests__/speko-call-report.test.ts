import { VOICE_RESULT_NOTIFICATION, VOICE_REPEAT_NOTIFICATION } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { parseSpekoCallReport } from "../services/voice/speko-call-report.js";
const turn = { id: "turn", index: 0, source: "user", text: "Hello", started_at: "2026-10-07T17:00:00Z", ended_at: null };
const report = { id: "call", duration_seconds: 60, report: { session_id: "call", updated_at: "2026-10-07T17:01:00Z", cost_micro_usd: "999999999999999999999999999999", transcript: { entries: [turn] } } };
describe("Speko call report projection", () => {
  it("allowlists spoken turns and exact costs without provider metadata or recordings", () => {
    const result = parseSpekoCallReport({ ...report, recording_resource_uri: "private-recording", metadata: { token: "private" } }, "call");
    expect(result).toMatchObject({ complete: true, costMicroUsd: report.report.cost_micro_usd, transcript: [{ speaker: "caller", text: "Hello" }] });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("deduplicates turns, sorts them, excludes system text, and redacts known credentials", () => {
    const result = parseSpekoCallReport({ ...report, report: { ...report.report, transcript: { entries: [turn, {...turn, text: "server-key"}, {...turn, id: "hidden", source: "system", text: "private prompt"}, {...turn, id: "second", source: "agent", index: 2, latency_status: "interrupted"}] } } }, "call", ["server-key"]);
    expect(result.transcript).toHaveLength(2);
    expect(result.transcript[0]?.text).toBe("[REDACTED]");
    expect(result.transcript[1]).toMatchObject({ speaker: "agent", interrupted: true });
  });
  it("excludes application control messages that the provider labels as user turns", () => {
    const entries = [turn, ...[VOICE_RESULT_NOTIFICATION, VOICE_REPEAT_NOTIFICATION].map((text, index) => ({...turn, id: `control-${index}`, index: index + 1, text}))];
    expect(parseSpekoCallReport({...report, report: {...report.report, transcript: {entries}}}, "call").transcript).toEqual([expect.objectContaining({text: "Hello", speaker: "caller"})]);
  });
  it("preserves unavailable costs and partial transcript status", () => {
    expect(parseSpekoCallReport({ id: "call", transcript: {entries: [turn]} }, "call")).toMatchObject({ complete: false, costMicroUsd: null, durationSeconds: null });
  });
  it("projects the real finalized report's camelCase timestamps", () => {
    const {started_at, ended_at, ...rest} = turn;
    const result = parseSpekoCallReport({...report, report: {...report.report, transcript: {entries: [{...rest, startedAt: started_at, endedAt: ended_at}]}}}, "call");
    expect(result).toMatchObject({complete: true, transcript: [{startedAt: started_at, endedAt: null}]});
    expect(() => parseSpekoCallReport({...report, report: {...report.report, transcript: {entries: [rest]}}}, "call")).toThrow();
  });
  it("normalizes real-provider fractional durations for durable integer storage", () => {
    expect(parseSpekoCallReport({...report, duration_seconds: 65.6}, "call").durationSeconds).toBe(66);
    expect(() => parseSpekoCallReport({...report, duration_seconds: Infinity}, "call")).toThrow();
  });
  it("rejects cross-call reports and invalid cost or transcript data", () => {
    for (const value of [{...report, id: "other"}, {...report, report: {...report.report, session_id: "other"}}, {...report, report: {...report.report, cost_micro_usd: "-1"}}, {...report, report: {...report.report, transcript: {entries: [{...turn, index: -1}]}}}]) expect(() => parseSpekoCallReport(value, "call")).toThrow();
  });
});
