import { describe, expect, it, vi } from "vitest";
import { assertAcpxProfileEnvironment, classifyAcpxProfileError, probeAcpxPiInstallation } from "./profile-installation.js";

describe("Cursor actionable admission errors", () => {
  it("requires an explicit bound credential and supports both company-secret names", () => {
    expect(() => assertAcpxProfileEnvironment("cursor", {})).toThrow("Bind a company secret");
    expect(() => assertAcpxProfileEnvironment("cursor", { CURSOR_AUTH_TOKEN: " " })).toThrow();
    for (const key of ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"]) expect(() => assertAcpxProfileEnvironment("cursor", { [key]: "fixture" })).not.toThrow();
    expect(() => assertAcpxProfileEnvironment("claude", {})).not.toThrow();
  });

  it.each([
    ["unauthorized: private-value", "CURSOR_AUTHENTICATION_FAILED"],
    ["model fixture is unavailable: private-value", "CURSOR_MODEL_UNAVAILABLE"],
    ["quota exceeded: private-value", "CURSOR_ENTITLEMENT_UNAVAILABLE"],
  ])("reports %s without echoing provider details or authorizing retries", (message, code) => {
    const result = classifyAcpxProfileError("cursor", new Error(message));
    expect(result).toMatchObject({ code, retryable: false });
    expect(result?.message).not.toContain("private-value");
  });

  it("preserves unrelated failures without inventing a provider diagnosis", () => {
    expect(classifyAcpxProfileError("cursor", new Error("filesystem is busy"))).toBeNull();
    expect(classifyAcpxProfileError("codex", new Error("unauthorized"))).toBeNull();
  });
});

const piProbe = vi.hoisted(() => ({ verify: vi.fn(), open: vi.fn(), close: vi.fn() }));
vi.mock("./pi-installation.js", () => ({ verifyPiInstallation: piProbe.verify }));
it("probes Pi through its pinned distribution and closes the verified snapshot lease", async () => {
  piProbe.verify.mockResolvedValue({ openCommand: piProbe.open });
  piProbe.open.mockResolvedValue({ close: piProbe.close });
  await probeAcpxPiInstallation("openrouter/anthropic/claude-sonnet-4.5");
  expect(piProbe.verify).toHaveBeenCalledWith(expect.objectContaining({ agent: "pi", qualificationModel: "openrouter/anthropic/claude-sonnet-4.5" }));
  expect(piProbe.close).toHaveBeenCalledTimes(1);
  piProbe.verify.mockRejectedValueOnce(new Error("Pi distribution failed verification"));
  await expect(probeAcpxPiInstallation("openrouter/anthropic/claude-sonnet-4.5")).rejects.toThrow("failed verification");
  expect(piProbe.close).toHaveBeenCalledTimes(1);
});
