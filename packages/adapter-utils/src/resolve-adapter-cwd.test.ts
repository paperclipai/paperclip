import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAdapterWorkingDirectory } from "./server-utils.js";

describe("resolveAdapterWorkingDirectory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers the workspace cwd", async () => {
    const onLog = vi.fn(async () => {});
    const cwd = await resolveAdapterWorkingDirectory({
      adapterType: "opencode_local",
      workspaceCwd: "/workspaces/project",
      configuredCwd: "/configured/elsewhere",
      onLog,
    });
    expect(cwd).toBe("/workspaces/project");
    expect(onLog).not.toHaveBeenCalled();
  });

  it("falls back to the configured cwd without warning", async () => {
    const onLog = vi.fn(async () => {});
    const cwd = await resolveAdapterWorkingDirectory({
      adapterType: "claude_local",
      workspaceCwd: "",
      configuredCwd: "/configured/project",
      onLog,
    });
    expect(cwd).toBe("/configured/project");
    expect(onLog).not.toHaveBeenCalled();
  });

  it("reports the fallback through onLog so it reaches the run transcript", async () => {
    const onLog = vi.fn(async () => {});
    const cwd = await resolveAdapterWorkingDirectory({
      adapterType: "codex_local",
      workspaceCwd: "",
      configuredCwd: "",
      onLog,
    });

    expect(cwd).toBe(process.cwd());
    expect(onLog).toHaveBeenCalledTimes(1);

    const [stream, chunk] = onLog.mock.calls[0] as unknown as [string, string];
    expect(stream).toBe("stderr");
    expect(chunk).toContain("codex_local");
    expect(chunk).toContain(process.cwd());
    // The remedy must be actionable, not just a notice that something happened.
    expect(chunk).toMatch(/project workspace/i);
    expect(chunk.endsWith("\n")).toBe(true);
  });

  it("falls back to console.warn when no onLog channel is supplied", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cwd = await resolveAdapterWorkingDirectory({
      adapterType: "pi_local",
      workspaceCwd: "",
      configuredCwd: "",
    });

    expect(cwd).toBe(process.cwd());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("pi_local");
  });
});
