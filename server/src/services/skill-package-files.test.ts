import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CompanySkillVersionFileInventoryEntry } from "@paperclipai/shared";
import { writeSkillPackageArchive } from "./skill-package-files.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("rejects an archive write cancelled mid-entry without an unhandled entry stream error", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-package-files-test-")); roots.push(root);
  const files: CompanySkillVersionFileInventoryEntry[] = Array.from({ length: 4 }, (_, index) => ({
    path: `assets/${index}.bin`, kind: "asset", encoding: "base64",
    content: randomBytes(4 * 1024 * 1024).toString("base64"),
  }));
  const uncaught: unknown[] = [], record = (error: unknown) => { uncaught.push(error); };
  process.on("uncaughtException", record);
  try {
    const controller = new AbortController();
    const writing = writeSkillPackageArchive(join(root, "files.tar.gz"), files, controller.signal);
    setTimeout(() => controller.abort(new Error("test deadline")), 1);
    await expect(writing).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(uncaught).toEqual([]);
  } finally { process.off("uncaughtException", record); }
});
