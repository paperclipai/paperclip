import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadInstructions } from "../src/instructions.js";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...cleanupPaths].map((target) => fs.rm(target, { recursive: true, force: true })));
  cleanupPaths.clear();
});

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-custom-llm-local-"));
  cleanupPaths.add(dir);
  return dir;
}

describe("loadInstructions", () => {
  it("successfully reads file content", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "AGENTS.md");
    await fs.writeFile(file, "You are focused.\n", "utf8");

    await expect(loadInstructions(file)).resolves.toBe("You are focused.\n");
  });

  it("throws CONFIG_INVALID for ENOENT", async () => {
    const dir = await makeTempDir();
    await expect(loadInstructions(path.join(dir, "missing.md"))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("throws CONFIG_INVALID for permission errors", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(new Error("EACCES: permission denied"));

    await expect(loadInstructions("/private/AGENTS.md")).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });
});
