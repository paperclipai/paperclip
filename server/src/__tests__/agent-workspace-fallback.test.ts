import { describe, expect, it, vi } from "vitest";
import { resolveAgentConfigCwdFallback } from "../services/agent-workspace-fallback.js";

describe("resolveAgentConfigCwdFallback", () => {
  it("returns the configured cwd when it exists on disk", async () => {
    const dirExists = vi.fn().mockResolvedValue(true);
    const result = await resolveAgentConfigCwdFallback({
      adapterConfig: {
        cwd: "C:/Users/VIKINGIST/Documents/www/ElectroBoard/electroboard",
        workspaceStrategy: { type: "git_worktree", baseRef: "master" },
      },
      dirExists,
    });
    expect(result).toEqual({
      cwd: "C:/Users/VIKINGIST/Documents/www/ElectroBoard/electroboard",
    });
    expect(dirExists).toHaveBeenCalledWith(
      "C:/Users/VIKINGIST/Documents/www/ElectroBoard/electroboard",
    );
  });

  it("returns null when cwd is unset", async () => {
    const dirExists = vi.fn();
    expect(
      await resolveAgentConfigCwdFallback({
        adapterConfig: { workspaceStrategy: { type: "project_primary" } },
        dirExists,
      }),
    ).toBeNull();
    expect(dirExists).not.toHaveBeenCalled();
  });

  it("returns null when cwd is empty string", async () => {
    const dirExists = vi.fn();
    expect(
      await resolveAgentConfigCwdFallback({
        adapterConfig: { cwd: "" },
        dirExists,
      }),
    ).toBeNull();
    expect(dirExists).not.toHaveBeenCalled();
  });

  it("returns null when cwd is not a string", async () => {
    const dirExists = vi.fn();
    expect(
      await resolveAgentConfigCwdFallback({
        adapterConfig: { cwd: 42 },
        dirExists,
      }),
    ).toBeNull();
    expect(
      await resolveAgentConfigCwdFallback({
        adapterConfig: { cwd: { nested: "x" } },
        dirExists,
      }),
    ).toBeNull();
    expect(dirExists).not.toHaveBeenCalled();
  });

  it("returns null when configured cwd does not exist on disk", async () => {
    const dirExists = vi.fn().mockResolvedValue(false);
    const result = await resolveAgentConfigCwdFallback({
      adapterConfig: { cwd: "C:/nonexistent/path" },
      dirExists,
    });
    expect(result).toBeNull();
    expect(dirExists).toHaveBeenCalledWith("C:/nonexistent/path");
  });

  it("returns null when adapterConfig is not an object (defensive)", async () => {
    const dirExists = vi.fn();
    expect(
      await resolveAgentConfigCwdFallback({ adapterConfig: null, dirExists }),
    ).toBeNull();
    expect(
      await resolveAgentConfigCwdFallback({ adapterConfig: undefined, dirExists }),
    ).toBeNull();
    expect(
      await resolveAgentConfigCwdFallback({ adapterConfig: "not-an-object", dirExists }),
    ).toBeNull();
    expect(dirExists).not.toHaveBeenCalled();
  });

  it("propagates dirExists rejection (caller decides retry policy)", async () => {
    const dirExists = vi.fn().mockRejectedValue(new Error("EACCES"));
    await expect(
      resolveAgentConfigCwdFallback({
        adapterConfig: { cwd: "C:/restricted" },
        dirExists,
      }),
    ).rejects.toThrow("EACCES");
  });
});
