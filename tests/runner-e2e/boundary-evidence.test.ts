import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { packageEvidence } from "./evidence.js";
const execFileAsync = promisify(execFile);
const boundarySnapshots = ["chat-boundary-definition.json", "chat-boundary-intent.json", "chat-boundary-observation.json", "chat-boundary-cleanup.json"];
async function passingBoundaryEvidence(omit?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "boundary-evidence-"));
  for (const dir of ["snapshots", "html-report", "blob-report"]) await mkdir(path.join(root, dir));
  const files: Record<string, string> = { "result.json": "{}", "junit.xml": "<testsuite/>", "html-report/index.html": "<html/>", "blob-report/receipt.txt": "synthetic unit fixture" };
  for (const name of boundarySnapshots) files[`snapshots/${name}`] = "{}";
  for (const [file, content] of Object.entries(files)) if (file !== omit) await writeFile(path.join(root, file), content);
  await execFileAsync("zip", ["-q", "report.zip", "receipt.txt"], { cwd: path.join(root, "blob-report") }); await rm(path.join(root, "blob-report/receipt.txt"));
  return root;
}
it("accepts a passing browser boundary that retains its own boundary records instead of task-flow files", async () => {
  const root = await passingBoundaryEvidence(), upload = `${root}-upload`;
  try {
    expect((await packageEvidence({ privateDir: root, uploadDir: upload, secrets: [], expectPassScreenshot: true, requiredPassEvidence: "browser-boundary" })).missing).toEqual([]);
    // The ordinary task-flow contract is unchanged: the same tree still lacks its task evidence.
    expect((await packageEvidence({ privateDir: root, uploadDir: upload, secrets: [], expectPassScreenshot: true })).missing)
      .toEqual(["final-state.png", path.join("snapshots", "fixtures.json"), path.join("snapshots", "api-state.json")]);
  } finally { await rm(root, { recursive: true, force: true }); await rm(upload, { recursive: true, force: true }); }
});
it("still fails a passing browser boundary that lost its graded observation or cleanup receipt", async () => {
  for (const omit of ["snapshots/chat-boundary-observation.json", "snapshots/chat-boundary-cleanup.json"]) {
    const root = await passingBoundaryEvidence(omit), upload = `${root}-upload`;
    try {
      expect((await packageEvidence({ privateDir: root, uploadDir: upload, secrets: [], expectPassScreenshot: true, requiredPassEvidence: "browser-boundary" })).missing)
        .toEqual([path.join(...omit.split("/"))]);
    } finally { await rm(root, { recursive: true, force: true }); await rm(upload, { recursive: true, force: true }); }
  }
});
