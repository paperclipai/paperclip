import { describe, expect, it } from "vitest";
import {
  buildMcInboundCeoHandoffPlan,
  classifyMcInboundTriggerPayload,
  evaluateMcInboundTriggerPayloadFilter,
  sanitizeMcInboundPayloadForCeoHandoff,
} from "./mc-inbound-trigger-payload.js";

const SECRET_BEARER = "pc_live_secret_should_never_leak_to_ceo";
const SECRET_URL = "https://hooks.example.internal/callback?token=abc";

function actionableFixture(type: string) {
  return {
    type,
    company: "TSR",
    summary: `Actionable ${type} summary`,
    details: "Operational details for CEO triage",
    ask: `Please handle ${type}`,
    callback: {
      url: SECRET_URL,
      bearer: SECRET_BEARER,
      authorization: `Bearer ${SECRET_BEARER}`,
    },
    callbackUrl: SECRET_URL,
    bearerToken: SECRET_BEARER,
    ackCallback: {
      url: SECRET_URL,
      bearer: SECRET_BEARER,
    },
  };
}

describe("classifyMcInboundTriggerPayload", () => {
  it("closes handshake as done with no CEO handoff", () => {
    const result = classifyMcInboundTriggerPayload({ type: "handshake", source: "mc" });
    expect(result).toMatchObject({
      route: "liveness_done",
      signal: "handshake",
      executionIssueStatus: "done",
      createCeoHandoff: false,
      preserveCtoRouting: false,
    });
  });

  it("closes binding_probe type as done with no CEO handoff", () => {
    const result = classifyMcInboundTriggerPayload({ type: "binding_probe", probeRunId: "p1" });
    expect(result).toMatchObject({
      route: "liveness_done",
      signal: "binding_probe",
      executionIssueStatus: "done",
      createCeoHandoff: false,
    });
  });

  it("closes _binding_probe flag as done even when type is spoofed actionable", () => {
    const result = classifyMcInboundTriggerPayload({
      type: "portfolio_directive",
      _binding_probe: true,
      ask: "should not become CEO work",
    });
    expect(result).toMatchObject({
      route: "liveness_done",
      signal: "_binding_probe",
      executionIssueStatus: "done",
      createCeoHandoff: false,
    });
  });

  it("accepts stringy _binding_probe truthy values", () => {
    expect(classifyMcInboundTriggerPayload({ _binding_probe: "true" }).route).toBe("liveness_done");
    expect(classifyMcInboundTriggerPayload({ _binding_probe: "1" }).route).toBe("liveness_done");
  });

  it("closes keepalive table equivalents as done", () => {
    for (const type of ["keepalive", "liveness", "preflight", "ping"]) {
      const result = classifyMcInboundTriggerPayload({ type });
      expect(result.route, type).toBe("liveness_done");
      expect(result.executionIssueStatus, type).toBe("done");
      expect(result.createCeoHandoff, type).toBe(false);
    }
    expect(classifyMcInboundTriggerPayload({ _mc_machine_ping: true }).route).toBe("liveness_done");
  });

  it.each([
    "portfolio_directive",
    "portfolio_input_request",
    "approval_request",
    "escalation",
    "clarification",
  ] as const)("routes %s to one CEO handoff", (type) => {
    const result = classifyMcInboundTriggerPayload(actionableFixture(type));
    expect(result).toMatchObject({
      route: "ceo_handoff",
      signal: type,
      executionIssueStatus: null,
      createCeoHandoff: true,
      preserveCtoRouting: false,
    });
  });

  it("preserves unknown shapes on safe CTO technical routing", () => {
    const result = classifyMcInboundTriggerPayload({
      type: "opco_internal_metrics_rollup",
      metrics: { cpu: 1 },
      callback: { url: SECRET_URL, bearer: SECRET_BEARER },
    });
    expect(result).toMatchObject({
      route: "cto_technical",
      signal: "opco_internal_metrics_rollup",
      executionIssueStatus: null,
      createCeoHandoff: false,
      preserveCtoRouting: true,
      reason: "unknown_shape_safe_cto_routing",
    });
  });

  it("does not infer type from missing payload / non-objects", () => {
    expect(classifyMcInboundTriggerPayload(null).preserveCtoRouting).toBe(true);
    expect(classifyMcInboundTriggerPayload(undefined).route).toBe("cto_technical");
    expect(classifyMcInboundTriggerPayload("portfolio_directive").route).toBe("cto_technical");
    expect(classifyMcInboundTriggerPayload([]).route).toBe("cto_technical");
  });

  it("reads kind when type is absent", () => {
    expect(classifyMcInboundTriggerPayload({ kind: "escalation" }).signal).toBe("escalation");
    expect(classifyMcInboundTriggerPayload({ kind: "handshake" }).route).toBe("liveness_done");
  });
});

describe("sanitizeMcInboundPayloadForCeoHandoff", () => {
  it("redacts callback credentials and transport metadata", () => {
    const sanitized = sanitizeMcInboundPayloadForCeoHandoff(actionableFixture("portfolio_input_request"));
    const blob = JSON.stringify(sanitized);

    expect(blob).not.toContain(SECRET_BEARER);
    expect(blob).not.toContain(SECRET_URL);
    expect(blob).not.toContain("hooks.example.internal");
    expect(sanitized.summary).toBe("Actionable portfolio_input_request summary");
    expect(sanitized.ask).toBe("Please handle portfolio_input_request");
    expect(sanitized.company).toBe("TSR");
    expect(sanitized.callback).toEqual({ redacted: true, reason: "callback_transport_omitted" });
    expect(sanitized.ackCallback).toEqual({ redacted: true, reason: "callback_transport_omitted" });
    expect(sanitized.callbackUrl).toBe("***REDACTED***");
    expect(sanitized.bearerToken).toBe("***REDACTED***");
  });

  it("never leaves nested bearer values under non-callback keys when named secret-like", () => {
    const sanitized = sanitizeMcInboundPayloadForCeoHandoff({
      type: "approval_request",
      summary: "ok",
      nested: { apiKey: "sk-test-1234567890", note: "keep" },
    });
    const blob = JSON.stringify(sanitized);
    expect(blob).not.toContain("sk-test-1234567890");
    expect((sanitized.nested as { note: string }).note).toBe("keep");
  });
});

describe("buildMcInboundCeoHandoffPlan / evaluateMcInboundTriggerPayloadFilter", () => {
  it("builds one sanitized CEO handoff with source execution issue reference", () => {
    const plan = buildMcInboundCeoHandoffPlan({
      triggerPayload: actionableFixture("portfolio_input_request"),
      sourceExecutionIssueId: "exec-uuid-1",
      sourceExecutionIssueIdentifier: "TSR-4965",
    });

    expect(plan.payloadType).toBe("portfolio_input_request");
    expect(plan.sourceExecutionIssueIdentifier).toBe("TSR-4965");
    expect(plan.sanitizedContent.sourceExecutionIssue).toEqual({
      id: "exec-uuid-1",
      identifier: "TSR-4965",
    });
    expect(plan.summary).toContain("portfolio_input_request");
    expect(JSON.stringify(plan)).not.toContain(SECRET_BEARER);
    expect(JSON.stringify(plan)).not.toContain(SECRET_URL);
  });

  it("evaluate returns null handoff for liveness and a plan for actionable", () => {
    const live = evaluateMcInboundTriggerPayloadFilter({
      triggerPayload: { type: "handshake" },
      sourceExecutionIssueIdentifier: "TSR-1",
    });
    expect(live.classification.route).toBe("liveness_done");
    expect(live.ceoHandoff).toBeNull();

    const action = evaluateMcInboundTriggerPayloadFilter({
      triggerPayload: actionableFixture("clarification"),
      sourceExecutionIssueId: "id-2",
      sourceExecutionIssueIdentifier: "TSR-2",
    });
    expect(action.classification.createCeoHandoff).toBe(true);
    expect(action.ceoHandoff?.payloadType).toBe("clarification");
    expect(JSON.stringify(action.ceoHandoff)).not.toContain(SECRET_BEARER);
  });

  it("unknown remains CTO technical with no CEO handoff plan", () => {
    const result = evaluateMcInboundTriggerPayloadFilter({
      triggerPayload: { type: "weird_shape", body: "x" },
    });
    expect(result.classification.preserveCtoRouting).toBe(true);
    expect(result.ceoHandoff).toBeNull();
  });
});
