import { describe, expect, it } from "vitest";

import {
  acpxCapabilities,
  acpxDriverDescriptor,
  validateAcpxDriverConfig,
} from "./driver-profile.js";

describe("ACPX driver profile", () => {
  it.each([
    ["codex", "available"],
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

  it.each([
    ["claude", "claude-sonnet-5"],
    ["codex", "gpt-5.6-sol"],
  ] as const)("accepts the exact qualified %s model", (agent, model) => {
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
      validateAcpxDriverConfig({ agent: "codex", model: "other" }),
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
      issues: [{ path: "agent", code: "invalid_agent" }],
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
