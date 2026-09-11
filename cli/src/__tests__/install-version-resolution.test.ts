import { describe, expect, it, vi } from "vitest";
import { resolvePublishedVersion } from "../commands/install.js";

describe("resolvePublishedVersion", () => {
  it("accepts npm's single-version JSON array response", async () => {
    const runCommand = vi.fn(async () => ({ stdout: '["2026.824.1"]\n', stderr: "" }));

    await expect(resolvePublishedVersion("latest", runCommand)).resolves.toBe("2026.824.1");
  });

  it("still accepts npm's JSON string response", async () => {
    const runCommand = vi.fn(async () => ({ stdout: '"2026.824.1"\n', stderr: "" }));

    await expect(resolvePublishedVersion("latest", runCommand)).resolves.toBe("2026.824.1");
  });

  it("rejects ambiguous multi-version arrays", async () => {
    const runCommand = vi.fn(async () => ({ stdout: '["2026.824.1","2026.825.0"]\n', stderr: "" }));

    await expect(resolvePublishedVersion("latest", runCommand)).rejects.toThrow(
      "npm returned an unexpected version response",
    );
  });
});
