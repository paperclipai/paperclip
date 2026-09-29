import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { packageEvidence } from "./evidence.js";
it("preserves the before-decision screenshot in the packaged attempt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "decision-evidence-"));
  try {
    const privateDir = path.join(root, "private");
    const uploadDir = path.join(root, "upload");
    await mkdir(privateDir);
    const bytes = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(path.join(privateDir, "decision-pending.png"), bytes);
    const packaged = await packageEvidence({
      privateDir,
      uploadDir,
      secrets: [],
      expectPassScreenshot: false,
    });
    expect(packaged.files).toContain("decision-pending.png");
    expect(
      await readFile(path.join(uploadDir, "decision-pending.png")),
    ).toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
