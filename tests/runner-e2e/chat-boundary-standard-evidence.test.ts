import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { packageEvidence } from "./evidence.js";
import { boundaryStandardSnapshots, emptyBoundaryResourceTrail, recordBoundaryResources } from "./chat-boundary-standard-evidence.js";
const execFileAsync = promisify(execFile);
it("records only the resources the boundary reported, without duplicates", () => {
  const trail = emptyBoundaryResourceTrail();
  recordBoundaryResources(trail, { companyId: "company", runIds: [] });
  recordBoundaryResources(trail, { companyId: "company", agentId: "morgan", runIds: ["run"] });
  recordBoundaryResources(trail, { companyId: "company", agentId: "morgan", runIds: ["run"] });
  expect(trail).toEqual({ companyIds: ["company"], agentIds: ["morgan"], runIds: ["run"] });
});
it("refuses to retain pass evidence without the boundary's own graded observation", () => {
  expect(() => boundaryStandardSnapshots({ scenarioId: "access.sign-in", trail: emptyBoundaryResourceTrail(), boundaryObservation: undefined })).toThrow("graded observation");
});
it("gives a passing boundary every standard pass file the launcher and private transfer require", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "boundary-standard-")), upload = `${root}-upload`;
  try {
    for (const dir of ["snapshots", "html-report", "blob-report"]) await mkdir(path.join(root, dir));
    const snapshots = boundaryStandardSnapshots({ scenarioId: "agent-chat.chat-disabled", trail: { companyIds: ["company"], agentIds: ["morgan"], runIds: [] },
      boundaryObservation: { scenarioId: "agent-chat.chat-disabled", querySent: false, grade: { passed: true, checks: [] } } });
    const files: Record<string, string> = { "result.json": "{}", "junit.xml": "<testsuite/>", "html-report/index.html": "<html/>", "blob-report/receipt.txt": "synthetic unit fixture",
      "snapshots/fixtures.json": JSON.stringify(snapshots.fixtures), "snapshots/api-state.json": JSON.stringify(snapshots.apiState), "final-state.png": "unit PNG custody fixture" };
    for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, file), content);
    await execFileAsync("zip", ["-q", "report.zip", "receipt.txt"], { cwd: path.join(root, "blob-report") }); await rm(path.join(root, "blob-report/receipt.txt"));
    expect((await packageEvidence({ privateDir: root, uploadDir: upload, secrets: [], expectPassScreenshot: true })).missing).toEqual([]);
    expect(snapshots.fixtures.manufacturedFixtures).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(upload, { recursive: true, force: true }); }
});
