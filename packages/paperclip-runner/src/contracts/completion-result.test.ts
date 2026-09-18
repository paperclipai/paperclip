import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  PRP_BLOCK_RESULT_OUTPUT_SCHEMA,
  PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA,
  PRP_COMPLETION_RESULT_OUTPUT_SCHEMA,
  PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA,
} from "./completion-result.js";
import { codexSemanticToolSpecs } from "../drivers/codex/codex-driver-values.js";

const baseResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "Completed the requested work.",
  completionClaim: {
    contractRevision: "1",
    objectiveSatisfied: true,
    criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }],
    remainingWork: [],
  },
  evidence: [],
  verification: [],
  attentionRequests: [],
  artifacts: [],
};

describe("provider-neutral completion result schema", () => {
  const validate = new Ajv2020({ allErrors: true, strict: false })
    .compile(PRP_COMPLETION_RESULT_OUTPUT_SCHEMA);

  it("allows done with no verification and no actionable attention", () => {
    expect(validate(structuredClone(baseResult))).toBe(true);
  });

  it("distinguishes user-facing answer content from the internal response-wake reason", () => {
    for (const schema of [
      PRP_COMPLETION_RESULT_OUTPUT_SCHEMA,
      PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA,
      PRP_BLOCK_RESULT_OUTPUT_SCHEMA,
      PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA,
    ]) {
      const summary = schema.properties.summary;
      expect(summary.description).toContain("complete user-facing answer");
      expect(summary.description).toContain(
        "genuine actionable failure, limitation, or required user action",
      );
      expect(summary.description).toContain(
        "Unless explicitly requested, omit routine preparation, unconfirmed-delivery, and wait/review status",
      );
      expect(summary.description).toContain(
        "Never claim delivery without a confirmed receipt",
      );
    }
    for (const schema of [
      PRP_COMPLETION_RESULT_OUTPUT_SCHEMA,
      PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA,
    ]) {
      const summary = schema.properties.continuation.properties.summary;
      expect(summary.description).toContain("Internal control-plane reason");
      expect(summary.description).toContain(
        "not in the top-level user-facing summary",
      );
      expect(summary.description).toContain("not the answer to the user's request");
    }
  });

  it("propagates answer and wait descriptions into the actual Codex semantic tool schemas", () => {
    const tools = JSON.parse(JSON.stringify(codexSemanticToolSpecs()));
    const finish = tools.find(
      (tool: { name: string }) => tool.name === "paperclip_finish",
    );
    const block = tools.find(
      (tool: { name: string }) => tool.name === "paperclip_block",
    );
    expect(finish.inputSchema.properties.summary.description).toContain(
      "complete user-facing answer",
    );
    expect(
      finish.inputSchema.properties.continuation.properties.summary.description,
    ).toContain("not in the top-level user-facing summary");
    expect(block.inputSchema.properties.summary.description).toContain(
      "genuine actionable failure, limitation, or required user action",
    );
    expect(finish.inputSchema).toEqual(PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA);
    expect(block.inputSchema).toEqual(PRP_BLOCK_RESULT_PROVIDER_INPUT_SCHEMA);
  });

  it("allows only a response-wake continuation when completion explicitly yields", () => {
    const yielded = {
      ...structuredClone(baseResult),
      reportedWorkDisposition: "yielded",
      completionClaim: {
        ...structuredClone(baseResult.completionClaim),
        objectiveSatisfied: false,
        remainingWork: [{ description: "Wait for the next response.", blocksCompletion: true }],
      },
      continuation: {
        kind: "response_wake",
        summary: "Resume after the next response.",
        idempotencyKey: "response-wake-1",
      },
    };
    expect(validate(yielded)).toBe(true);
    expect(validate({ ...yielded, continuation: undefined })).toBe(false);
    expect(validate({
      ...yielded,
      continuation: { ...yielded.continuation, kind: "same_agent" },
    })).toBe(false);
  });

  it("allows provider tool callers to omit the constant schema discriminator", () => {
    const providerValidate = new Ajv2020({ allErrors: true, strict: false })
      .compile(PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA);
    const providerResult = structuredClone(baseResult) as Record<string, unknown>;
    delete providerResult.schema;
    expect(providerValidate(providerResult)).toBe(true);
  });

  it.each(["done", "needs_review", "completed"])("rejects a response-wake continuation on %s", (disposition) => {
    const response = {
      ...structuredClone(baseResult),
      reportedWorkDisposition: disposition,
      attentionRequests: disposition === "needs_review"
        ? [{ kind: "review", summary: "Review this result.", ownerClass: "human" }]
        : [],
      continuation: { kind: "response_wake", summary: "Contradictory wait.", idempotencyKey: "wait-1" },
    };
    const providerValidate = new Ajv2020({ allErrors: true, strict: false })
      .compile(PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA);
    expect(providerValidate(response)).toBe(false);
    expect(validate(response)).toBe(false);
  });

  it("exposes concrete completion fields while retaining response-wake validation", () => {
    // The live Codex code-mode renderer reduced a conditional-only root allOf
    // to `args: unknown`. Keep this tool object-shaped for provider discovery.
    expect(PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA.type).toBe("object");
    expect(PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA).not.toHaveProperty("allOf");
    expect(PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA.required).toEqual([
      "reportedWorkDisposition", "summary", "completionClaim", "evidence", "verification",
    ]);
    expect(PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA.properties.continuation.required)
      .toEqual(["kind", "summary", "idempotencyKey"]);
    const providerValidate = new Ajv2020({ allErrors: true, strict: false })
      .compile(PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA);
    const yielded = {
      ...structuredClone(baseResult),
      reportedWorkDisposition: "yielded",
      continuation: {
        kind: "response_wake",
        summary: "Wait for the next response.",
        idempotencyKey: "response-wake-provider-1",
      },
    };
    expect(providerValidate(yielded)).toBe(true);
    expect(providerValidate({ ...yielded, continuation: undefined })).toBe(false);
    expect(providerValidate({ ...yielded, continuation: { kind: "response_wake" } })).toBe(false);
    expect(providerValidate({
      ...yielded, continuation: { ...yielded.continuation, kind: "same_agent" },
    })).toBe(false);
    expect(providerValidate({ ...yielded, evidence: undefined })).toBe(false);
  });

  it("admits known smaller-model aliases at the provider boundary for canonical normalization", () => {
    const providerValidate = new Ajv2020({ allErrors: true, strict: false })
      .compile(PRP_COMPLETION_RESULT_PROVIDER_INPUT_SCHEMA);
    const providerResult = structuredClone(baseResult);
    providerResult.schema = "paperclip_paperclip_finish";
    providerResult.reportedWorkDisposition = "completed";
    providerResult.completionClaim.criteria[0]!.status = "passed";
    providerResult.verification = [{ commandOrCheck: "model check", status: "pass" } as never];
    expect(providerValidate(providerResult)).toBe(true);
  });

  it("requires a reason code for verification that was not run", () => {
    const result = structuredClone(baseResult);
    result.verification = [{ commandOrCheck: "Run tests", status: "not_run" } as never];
    expect(validate(result)).toBe(false);

    result.verification = [{
      commandOrCheck: "Run tests",
      status: "not_run",
      reasonCode: "tool_unavailable",
    } as never];
    expect(validate(result)).toBe(true);
  });

  it("requires needs_review for actionable attention", () => {
    const result = structuredClone(baseResult);
    result.attentionRequests = [{
      kind: "review",
      summary: "Confirm the external result.",
      ownerClass: "human",
    } as never];
    expect(validate(result)).toBe(false);

    result.reportedWorkDisposition = "needs_review";
    expect(validate(result)).toBe(true);
  });

  it("requires agent-owned attention to identify its target agent", () => {
    const result = structuredClone(baseResult);
    result.reportedWorkDisposition = "needs_review";
    result.attentionRequests = [{
      kind: "agent_handoff",
      summary: "Ask the deployment agent to continue.",
      ownerClass: "agent",
    } as never];
    expect(validate(result)).toBe(false);
  });
});
