import { describe, expect, it } from "vitest";
import { isStagingOrigin, assertDeployedAdapterExclusions, deployedAgentEngine } from "./deployed-stack.js";

describe("deployed stack target", () => {
  it("requires an explicit HTTPS staging tenant and rejects credential-bearing URLs", () => {
    expect(isStagingOrigin("https://work-folders-qa.staging.paperclip.app")).toBe(true);
    for (const value of ["http://localhost:3100", "https://tenant.paperclip.app", "https://staging.paperclip.app.attacker.test",
      "https://token@tenant.staging.paperclip.app", "https://tenant.staging.paperclip.app/path", "https://tenant.staging.paperclip.app?secret=x"]) {
      expect(isStagingOrigin(value), value).toBe(false);
    }
  });
});

it("derives engine coverage from live adapter configuration", () => {
  expect(deployedAgentEngine({ adapterType: "codex_local", adapterConfig: {} })).toBe("cli");
  expect(deployedAgentEngine({ adapterType: "claude_local", adapterConfig: { engine: "acp" } })).toBe("acp");
  expect(deployedAgentEngine({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } })).toBe("codex");
  expect(deployedAgentEngine({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "pi" } })).toBe("acpx:pi");
  expect(deployedAgentEngine({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude" } })).not.toBe("acpx:pi");
  expect(() => deployedAgentEngine({ adapterType: "paperclip_runner", adapterConfig: { provider: "acpx" } })).toThrow("Missing");
  expect(() => deployedAgentEngine({ adapterType: "codex_local", adapterConfig: { engine: "unknown" } })).toThrow("Unknown");
});

it("allows only the four explicitly deferred adapters to be excluded", () => {
  expect(() => assertDeployedAdapterExclusions([{ adapterType: "cursor", reason: "Explicitly deferred by the user" }])).not.toThrow();
  for (const adapterType of ["codex_local", "claude_local", "opencode_local", "pi_local", "paperclip_runner"]) {
    expect(() => assertDeployedAdapterExclusions([{ adapterType, reason: "skip" }])).toThrow("cannot be excluded");
  }
});
