import { describe, expect, it, vi } from "vitest";

import { logCredentialBrokerFallbackToEnv } from "./credential-broker-log.js";

describe("logCredentialBrokerFallbackToEnv", () => {
  it("emits a structured warn with the credential-broker-fallback-to-env event tag", () => {
    const warn = vi.fn();
    logCredentialBrokerFallbackToEnv(
      { warn },
      {
        runId: "run-1",
        agentId: "a-1",
        executionTargetKind: "sandbox",
        sandboxProvider: "e2b",
        reason: "broker_unreachable_from_runtime",
        bindings: [{ envVarName: "GH", connectionId: "c-1" }],
      },
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const [payload, msg] = warn.mock.calls[0];
    expect(payload).toMatchObject({
      event: "credential-broker-fallback-to-env",
      runId: "run-1",
      agentId: "a-1",
      executionTarget: { kind: "sandbox", sandboxProvider: "e2b" },
      reason: "broker_unreachable_from_runtime",
      bindings: [{ envVarName: "GH", connectionId: "c-1" }],
    });
    expect(payload).toHaveProperty("hint");
    expect((payload as { hint: string }).hint).toContain("standalone");
    expect(msg).toMatch(/fell back/i);
  });

  it("hint for external_runtime_no_broker_targets mentions byo-broker remediation", () => {
    const warn = vi.fn();
    logCredentialBrokerFallbackToEnv(
      { warn },
      {
        runId: "r",
        agentId: "a",
        executionTargetKind: "external",
        reason: "external_runtime_no_broker_targets",
        bindings: [],
      },
    );
    const [payload] = warn.mock.calls[0];
    expect((payload as { hint: string }).hint).toContain("byo-broker");
  });

  it("hint for no_broker_registered references the builtin plugin name", () => {
    const warn = vi.fn();
    logCredentialBrokerFallbackToEnv(
      { warn },
      {
        runId: "r",
        agentId: "a",
        executionTargetKind: "local",
        reason: "no_broker_registered",
        bindings: [{ envVarName: "GH", connectionId: "c-1" }],
      },
    );
    const [payload] = warn.mock.calls[0];
    expect((payload as { hint: string }).hint).toContain(
      "@paperclipai/credential-broker-builtin",
    );
  });

  it("hint for provider_not_broker_compatible references the YAML flag", () => {
    const warn = vi.fn();
    logCredentialBrokerFallbackToEnv(
      { warn },
      {
        runId: "r",
        agentId: "a",
        executionTargetKind: "local",
        reason: "provider_not_broker_compatible",
        bindings: [{ envVarName: "GH", connectionId: "c-1" }],
      },
    );
    const [payload] = warn.mock.calls[0];
    expect((payload as { hint: string }).hint).toContain(
      "broker.supported: false",
    );
  });

  it("omits sandboxProvider in the payload when unset", () => {
    const warn = vi.fn();
    logCredentialBrokerFallbackToEnv(
      { warn },
      {
        runId: "r",
        agentId: "a",
        executionTargetKind: "local",
        reason: "no_broker_registered",
        bindings: [],
      },
    );
    const [payload] = warn.mock.calls[0];
    const target = (payload as { executionTarget: { sandboxProvider?: string } })
      .executionTarget;
    expect(target.sandboxProvider).toBeUndefined();
  });
});
