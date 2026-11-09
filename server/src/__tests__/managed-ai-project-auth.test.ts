import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertManagedAiProjectAuth } from "../services/ai-connection-runtime.js";

describe("managed Claude project routing", () => {
  it.each(["ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"])("rejects project routing override %s for every managed Claude route", async (key) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-routing-test-"));
    try {
      await mkdir(path.join(root, ".claude"));
      for (const filename of ["settings.json", "settings.local.json"]) {
        await writeFile(path.join(root, ".claude", filename), JSON.stringify({ env: { [key]: "override" } }));
        for (const engine of ["cli", "CLI", " cli ", "acp"]) {
          for (const provider of ["anthropic", "openrouter"] as const) {
            await expect(assertManagedAiProjectAuth({ cwd: root, engine }, provider, undefined, "claude_local")).rejects.toThrow("conflict");
          }
        }
        await unlink(path.join(root, ".claude", filename));
      }
      await writeFile(path.join(root, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Read(secret)"] } }));
      await expect(assertManagedAiProjectAuth({ cwd: root, engine: "CLI" }, "openrouter", undefined, "claude_local")).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
