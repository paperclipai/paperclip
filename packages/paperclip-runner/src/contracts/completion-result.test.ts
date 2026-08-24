import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  PRP_COMPLETION_RESULT_OUTPUT_SCHEMA,
  PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA,
} from "./completion-result.js";

const baseResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "Completed the requested work.",
  completionClaim: {
    contractRevision: "1",
    objectiveSatisfied: true,
    criteria: [
      { criterionId: "objective", status: "satisfied", evidenceRefs: [] },
    ],
    remainingWork: [],
  },
  evidence: [],
  verification: [],
  attentionRequests: [],
  artifacts: [],
};

describe("provider-neutral completion result schema", () => {
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
    PRP_COMPLETION_RESULT_OUTPUT_SCHEMA,
  );

  it("allows done with no verification and no actionable attention", () => {
    expect(validate(structuredClone(baseResult))).toBe(true);
  });

  it("allows provider tool callers to omit the constant schema discriminator", () => {
    const providerValidate = new Ajv2020({
      allErrors: true,
      strict: false,
    }).compile(PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA);
    const providerResult = structuredClone(baseResult) as Record<
      string,
      unknown
    >;
    delete providerResult.schema;
    expect(providerValidate(providerResult)).toBe(true);
  });

  it("admits known smaller-model aliases at the provider boundary for canonical normalization", () => {
    const providerValidate = new Ajv2020({
      allErrors: true,
      strict: false,
    }).compile(PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA);
    const providerResult = structuredClone(baseResult);
    providerResult.schema = "paperclip_paperclip_finish";
    providerResult.reportedWorkDisposition = "completed";
    providerResult.completionClaim.criteria[0]!.status = "passed";
    providerResult.verification = [
      { commandOrCheck: "model check", status: "pass" } as never,
    ];
    expect(providerValidate(providerResult)).toBe(true);
  });

  it("requires a reason code for verification that was not run", () => {
    const result = structuredClone(baseResult);
    result.verification = [
      { commandOrCheck: "Run tests", status: "not_run" } as never,
    ];
    expect(validate(result)).toBe(false);

    result.verification = [
      {
        commandOrCheck: "Run tests",
        status: "not_run",
        reasonCode: "tool_unavailable",
      } as never,
    ];
    expect(validate(result)).toBe(true);
  });

  it("requires needs_review for actionable attention", () => {
    const result = structuredClone(baseResult);
    result.attentionRequests = [
      {
        kind: "review",
        summary: "Confirm the external result.",
        ownerClass: "human",
      } as never,
    ];
    expect(validate(result)).toBe(false);

    result.reportedWorkDisposition = "needs_review";
    expect(validate(result)).toBe(true);
  });

  it("requires agent-owned attention to identify its target agent", () => {
    const result = structuredClone(baseResult);
    result.reportedWorkDisposition = "needs_review";
    result.attentionRequests = [
      {
        kind: "agent_handoff",
        summary: "Ask the deployment agent to continue.",
        ownerClass: "agent",
      } as never,
    ];
    expect(validate(result)).toBe(false);
  });
});
