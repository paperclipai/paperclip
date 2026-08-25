import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAdapterWorkingDirectory } from "./server-utils.js";

describe("resolveAdapterWorkingDirectory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers the workspace cwd", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cwd = resolveAdapterWorkingDirectory({
      adapterType: "opencode_local",
      workspaceCwd: "/workspaces/project",
      configuredCwd: "/configured/elsewhere",
    });
    expect(cwd).toBe("/workspaces/project");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the configured cwd without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cwd = resolveAdapterWorkingDirectory({
      adapterType: "claude_local",
      workspaceCwd: "",
      configuredCwd: "/configured/project",
    });
    expect(cwd).toBe("/configured/project");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when neither resolves, naming the directory it fell back to", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cwd = resolveAdapterWorkingDirectory({
      adapterType: "codex_local",
      workspaceCwd: "",
      configuredCwd: "",
    });

    expect(cwd).toBe(process.cwd());
    expect(warn).toHaveBeenCalledTimes(1);

    const message = String(warn.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("codex_local");
    expect(message).toContain(process.cwd());
    // The remedy must be actionable, not just a notice that something happened.
    expect(message).toMatch(/project workspace/i);
  });
});
