import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { packageEvidence } from "./evidence.js";
import { emitContextIntegrityFinalEvidence } from "./context-integrity-evidence.js";

const execFileAsync = promisify(execFile);

async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "context-integrity-evidence-"));
  await mkdir(path.join(root, "snapshots"), { recursive: true });
  await mkdir(path.join(root, "html-report"), { recursive: true });
  await mkdir(path.join(root, "blob-report"), { recursive: true });
  await writeFile(path.join(root, "result.json"), "{}\n");
  await writeFile(path.join(root, "junit.xml"), "<testsuite/>\n");
  await writeFile(path.join(root, "snapshots", "fixtures.json"), "{}\n");
  await writeFile(path.join(root, "html-report", "index.html"), "<html/>\n");
  const blobReport = path.join(root, "blob-report");
  await writeFile(path.join(blobReport, "report.txt"), "playwright report\n");
  await execFileAsync("zip", ["-q", "report.zip", "report.txt"], { cwd: blobReport });
  await rm(path.join(blobReport, "report.txt"));
  return root;
}

describe("context integrity final evidence contract", () => {
  it("emits files accepted by the real evidence packager", async () => {
    const privateDir = await fixtureRoot();
    const uploadDir = `${privateDir}-upload`;
    try {
      await emitContextIntegrityFinalEvidence({
        evidence: async (name, value) => writeFile(path.join(privateDir, "snapshots", name), `${JSON.stringify(value)}\n`),
        capture: async (_id, _label, file) => writeFile(path.join(privateDir, file), "png\n"),
        issue: { id: "issue" }, runs: [], checkpoints: [], checks: [],
      });
      const packaged = await packageEvidence({ privateDir, uploadDir, secrets: [], expectPassScreenshot: true });
      expect(packaged.missing).toEqual([]);
      await expect(readFile(path.join(uploadDir, "final-state.png"), "utf8")).resolves.toBe("png\n");
      await expect(readFile(path.join(uploadDir, "snapshots", "api-state.json"), "utf8")).resolves.toContain('"capturePhase": "final"');
    } finally {
      await rm(privateDir, { recursive: true, force: true });
      await rm(uploadDir, { recursive: true, force: true });
    }
  });

  it("rejects the former context-specific filenames", async () => {
    const privateDir = await fixtureRoot();
    const uploadDir = `${privateDir}-upload`;
    try {
      await writeFile(path.join(privateDir, "context-integrity-final.png"), "png\n");
      await writeFile(path.join(privateDir, "snapshots", "context-integrity.json"), "{}\n");
      const packaged = await packageEvidence({ privateDir, uploadDir, secrets: [], expectPassScreenshot: true });
      expect(packaged.missing).toContain("final-state.png");
      expect(packaged.missing).toContain(path.join("snapshots", "api-state.json"));
    } finally {
      await rm(privateDir, { recursive: true, force: true });
      await rm(uploadDir, { recursive: true, force: true });
    }
  });
});
