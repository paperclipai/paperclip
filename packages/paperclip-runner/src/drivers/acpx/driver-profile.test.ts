import { describe, expect, it } from "vitest";

import {
  acpxCapabilities,
  acpxDriverDescriptor,
  validateAcpxDriverConfig,
} from "./driver-profile.js";

describe("ACPX driver profile", () => {
  it("enables only negotiated Pi controls and keeps the static profile conservative", () => {
    expect(acpxCapabilities("pi")).toMatchObject({ steering: false, queuedFollowUp: false });
    expect(acpxCapabilities("pi", { steering: true, queuedFollowUp: false })).toMatchObject({ steering: true, queuedFollowUp: false });
    expect(acpxCapabilities("pi", { steering: false, queuedFollowUp: true })).toMatchObject({ steering: false, queuedFollowUp: true });
    for (const agent of ["cursor", "copilot", "codex", "claude"] as const) {
      expect(acpxCapabilities(agent, { steering: true, queuedFollowUp: true })).toMatchObject({ steering: false, queuedFollowUp: false });
    }
  });
  it.each([
    ["codex", "available"],
    ["grok", "available"],
    ["claude", "available"],
    ["pi", "unsupported"],
  ] as const)(
    "advertises structured plans for %s as %s",
    (agent, availability) => {
      const plan = acpxCapabilities(agent).typedEventFamilies?.find(
        (family) => family.family === "plan",
      );
      expect(plan).toMatchObject({
        availability,
        detailLevel: availability === "available" ? "structured" : "summary",
      });
    },
  );

  it("describes only implemented ACPX capability boundaries", () => {
    expect(acpxDriverDescriptor("claude")).toMatchObject({
      kind: "acpx_runtime",
      displayName: "Claude via ACPX",
      version: "0.13.1",
      protocolVersion: "acp/v1",
      runtimeContextCapabilities: {
        instructions: "native",
        skills: "native",
        mcp: "native",
      },
      capabilities: {
        resume: true,
        steering: false,
        interruption: true,
        dynamicTools: true,
        runtimeRequestResolution: true,
      },
    });
  });

  it.each(["claude", "codex", "grok", "cursor"] as const)("accepts an unlisted %s model for native verification", agent => {
    const model = "custom/model[reasoning=medium]";
    expect(validateAcpxDriverConfig({ agent, model })).toEqual({
      ok: true,
      config: { agent, model, permissionMode: "approve-all" },
      issues: [],
    });
  });

  it("fails closed for unknown fields and unqualified settings", () => {
    expect(validateAcpxDriverConfig(null)).toMatchObject({
      ok: false,
      issues: [{ code: "invalid_config" }],
    });
    expect(
      validateAcpxDriverConfig({
        agent: "codex",
        model: "gpt-5.6-sol",
        command: "/tmp/arbitrary-provider",
      }),
    ).toMatchObject({
      ok: false,
      issues: [{ path: "command", code: "unknown_field" }],
    });
    expect(
      validateAcpxDriverConfig({ agent: "codex", model: " " }),
    ).toMatchObject({
      ok: false,
      issues: [{ path: "model", code: "invalid_model" }],
    });
    expect(
      validateAcpxDriverConfig({
        agent: "pi",
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
      }),
    ).toMatchObject({
      ok: false,
      issues: [{ path: "agent", code: "qualification_pending" }],
    });
    expect(
      validateAcpxDriverConfig({
        agent: "claude",
        model: "claude-sonnet-5",
        permissionMode: "unrestricted",
      }),
    ).toMatchObject({
      ok: false,
      issues: [{ path: "permissionMode", code: "invalid_permission_mode" }],
    });
    for (const permissionMode of ["", 42, undefined]) {
      expect(
        validateAcpxDriverConfig({
          agent: "claude",
          model: "claude-sonnet-5",
          permissionMode,
        }),
      ).toMatchObject({
        ok: false,
        issues: [{ path: "permissionMode", code: "invalid_permission_mode" }],
      });
    }
  });
});
