import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { replaceController, validControllerOutageReceipt } from "./controller-outage.js";
import { packageEvidence } from "./evidence.js";
import { runnerE2EServerControlPaths } from "./harness-env.js";
import { copySharedEvidence } from "./shared-evidence.js";

it.each(["start", "readiness", "recovery"])("publishes the last outage phase after %s fails and temporary state is deleted", async phase => {
  const root = await mkdtemp(path.join(tmpdir(), "outage-evidence-"));
  const temporaryRoot = path.join(root, "temporary");
  const privateRoot = path.join(temporaryRoot, "private");
  const caseDir = path.join(privateRoot, "cases", "recover-controller");
  const uploadDir = path.join(root, "published");
  const { controlDirectory } = runnerE2EServerControlPaths(temporaryRoot);
  const secret = "synthetic-evidence-credential";
  try {
    await mkdir(controlDirectory, { recursive: true });
    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(privateRoot, "server.log"), "server stopped\n");
    await writeFile(path.join(controlDirectory, "restart-request.json"), JSON.stringify({ token: secret }));
    await expect(replaceController({
      requestId: "attempt-1", previousPid: 100, outage: { signal: "SIGKILL", holdMs: 0 },
      stop: async () => {}, waitForUnhealthy: async () => {}, discardCache: async () => {},
      start: async () => { if (phase === "start") throw new Error(phase); return { pid: 200 }; },
      waitForReady: async () => { if (phase === "readiness") throw new Error(phase); },
      afterReady: async (receipt, record) => {
        receipt.recoveryProgress = { bootId: secret };
        await record();
        throw new Error(phase);
      },
      cancelled: () => false,
      record: async receipt => {
        await writeFile(path.join(controlDirectory, "controller-outage-attempt-1.json"), JSON.stringify(receipt));
      },
    })).rejects.toThrow(phase);
    await copySharedEvidence(privateRoot, caseDir, temporaryRoot, [secret]);
    const evidence = await packageEvidence({ privateDir: caseDir, uploadDir, secrets: [secret], expectPassScreenshot: false });
    await rm(temporaryRoot, { recursive: true, force: true });
    expect(evidence.leaks).toEqual([]);
    const relative = "snapshots/controller-outages/controller-outage-attempt-1.json";
    expect(evidence.files).toContain(relative);
    const text = await readFile(path.join(uploadDir, relative), "utf8");
    const receipt = JSON.parse(text);
    expect(text).not.toContain(secret);
    expect(receipt).toMatchObject({ requestId: "attempt-1", cacheDiscarded: true });
    if (phase === "start") expect(receipt).not.toHaveProperty("replacementPid");
    else expect(receipt.replacementPid).toBe(200);
    if (phase === "recovery") expect(receipt.recoveryProgress).toEqual({ bootId: "[REDACTED]" });
    else {
      expect(receipt).not.toHaveProperty("readyAfterMs");
      expect(validControllerOutageReceipt(receipt)).toBe(false);
    }
    expect(await readdir(uploadDir)).not.toContain("control");
    expect(evidence.files.some(file => file.includes("restart-request"))).toBe(false);
    expect(await readFile(path.join(uploadDir, "server.log"), "utf8")).toBe("server stopped\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("keeps ordinary evidence collection working when no outage was requested", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ordinary-evidence-"));
  try {
    await writeFile(path.join(root, "server.log"), "ordinary run\n");
    const caseDir = path.join(root, "case");
    await mkdir(caseDir);
    await copySharedEvidence(root, caseDir, root, []);
    expect(await readdir(caseDir)).toEqual(["server.log"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("retains sanitized corrupt receipt evidence without losing healthy receipts or logs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "corrupt-outage-evidence-"));
  const temporaryRoot = path.join(root, "temporary"), privateRoot = path.join(temporaryRoot, "private");
  const caseDir = path.join(privateRoot, "case"), uploadDir = path.join(root, "published");
  const { controlDirectory } = runnerE2EServerControlPaths(temporaryRoot);
  const secret = "synthetic-corrupt-receipt-secret";
  try {
    await mkdir(controlDirectory, { recursive: true }); await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(privateRoot, "server.log"), "original failure retained\n");
    await writeFile(path.join(controlDirectory, "controller-outage-a-broken.json"), `{"note":"${secret}"`);
    await writeFile(path.join(controlDirectory, "controller-outage-z-good.json"), JSON.stringify({ requestId: "good", stoppedAfterMs: 10 }));
    await copySharedEvidence(privateRoot, caseDir, temporaryRoot, [secret]);
    const result = await packageEvidence({ privateDir: caseDir, uploadDir, secrets: [secret], expectPassScreenshot: false });
    await rm(temporaryRoot, { recursive: true, force: true });
    expect(result.leaks).toEqual([]);
    const directory = path.join(uploadDir, "snapshots/controller-outages");
    const broken = JSON.parse(await readFile(path.join(directory, "controller-outage-a-broken.json"), "utf8"));
    expect(broken).toMatchObject({ error: "invalid_json", source: "controller-outage-a-broken.json" });
    expect(validControllerOutageReceipt(broken)).toBe(false);
    const raw = await readFile(path.join(directory, "controller-outage-a-broken.json.invalid.txt"), "utf8");
    expect(raw).not.toContain(secret); expect(raw).toContain("[REDACTED]");
    expect(JSON.parse(await readFile(path.join(directory, "controller-outage-z-good.json"), "utf8"))).toMatchObject({ requestId: "good" });
    expect(await readFile(path.join(uploadDir, "server.log"), "utf8")).toBe("original failure retained\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
