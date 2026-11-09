import { describe, expect, it } from "vitest";
import { NATIVE_FINALIZATION_SCHEMA } from "../types/native-finalization.js";
import { nativeFinalizationResultSchema } from "./native-finalization.js";

const validResult = {
  schema: NATIVE_FINALIZATION_SCHEMA,
  runtimeMode: "native",
  runId: "10000000-0000-4000-8000-000000000001",
  issueId: "10000000-0000-4000-8000-000000000002",
  companyId: "10000000-0000-4000-8000-000000000003",
  result: { summary: "Completed the requested work" },
  terminal: {
    schema: "paperclip.prp.terminal.v1",
    turnTerminalState: "completed",
    runTerminalState: "succeeded",
    reportedWorkDisposition: "done",
  },
  turnId: "turn-1",
  sourceInstanceId: "runner-instance-1",
  normalizedSessionId: "session-1",
  providerSessionId: "provider-session-1",
  driverKind: "codex",
  driverVersion: "1.0.0",
  nativeEventCount: 12,
  highestContiguousSourceSeq: 12,
  workspaceFinalizeStatus: "succeeded",
} as const;

describe("native finalization validators", () => {
  it("accepts the complete v1 finalization contract", () => {
    expect(nativeFinalizationResultSchema.parse(validResult)).toEqual(validResult);
  });

  it("fails closed for unknown required versions and extra fields", () => {
    expect(nativeFinalizationResultSchema.safeParse({
      ...validResult,
      schema: "paperclip.native-finalization.v2",
    }).success).toBe(false);
    expect(nativeFinalizationResultSchema.safeParse({
      ...validResult,
      unrecognizedRequiredField: true,
    }).success).toBe(false);
  });

  it("rejects invalid identities and sequence counters", () => {
    expect(nativeFinalizationResultSchema.safeParse({
      ...validResult,
      runId: "not-a-uuid",
    }).success).toBe(false);
    expect(nativeFinalizationResultSchema.safeParse({
      ...validResult,
      highestContiguousSourceSeq: -1,
    }).success).toBe(false);
  });
});
