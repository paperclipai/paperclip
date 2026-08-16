import { describe, expect, it, vi } from "vitest";
import { cleanupPluginManagedAgent } from "../services/plugin-loader.js";

describe("plugin managed-agent cleanup", () => {
  it("removes an agent when no historical rows reference it", async () => {
    const service = {
      remove: vi.fn(async () => undefined),
      terminate: vi.fn(async () => undefined),
    };

    await expect(
      cleanupPluginManagedAgent(service, "agent-1", "paperclip.example"),
    ).resolves.toBe("removed");
    expect(service.terminate).not.toHaveBeenCalled();
  });

  it("retains a terminated audit tombstone for wrapped foreign-key failures", async () => {
    const foreignKeyError = Object.assign(new Error("referenced by cost history"), { code: "23503" });
    const service = {
      remove: vi.fn(async () => {
        throw Object.assign(new Error("delete failed"), { cause: foreignKeyError });
      }),
      terminate: vi.fn(async () => undefined),
    };

    await expect(
      cleanupPluginManagedAgent(service, "agent-1", "paperclip.example"),
    ).resolves.toBe("retained_audit_tombstone");
    expect(service.terminate).toHaveBeenCalledWith("agent-1", {
      actorType: "plugin",
      actorId: "paperclip.example",
      source: "plugin_hard_purge_audit_tombstone",
    });
  });

  it("does not hide unrelated cleanup failures", async () => {
    const failure = new Error("database unavailable");
    const service = {
      remove: vi.fn(async () => {
        throw failure;
      }),
      terminate: vi.fn(async () => undefined),
    };

    await expect(
      cleanupPluginManagedAgent(service, "agent-1", "paperclip.example"),
    ).rejects.toBe(failure);
    expect(service.terminate).not.toHaveBeenCalled();
  });
});
