import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { ordinaryChatCapture } from "./chat-screenshot-capture.js";
import { packageEvidence } from "./evidence.js";
import { isHistoricalBundlePathAllowed } from "./history-publish.js";
import { isPublicRunnerScreenshotRoute } from "./screenshot-policy.js";
const execFileAsync = promisify(execFile);
it("retains catalog result and mandatory final-state captures privately without invoking the public route/marker callback", async () => {
  const privateCapture = vi.fn(async () => {}), publicCapture = vi.fn(async () => { throw new Error("Public route guard would reject the canonical Morgan slug"); });
  const capture = ordinaryChatCapture("chat-features", privateCapture, publicCapture);
  await capture("chat-catalog-result", "Verified result", "chat-catalog-result.png");
  await capture("final-state", "Verified final state", "final-state.png");
  expect(privateCapture.mock.calls).toEqual([["chat-catalog-result", "chat-catalog-result.png"], ["final-state", "final-state.png"]]);
  expect(publicCapture).not.toHaveBeenCalled();
  expect(isPublicRunnerScreenshotRoute("http://127.0.0.1:3100/RUN/chats/morgan", { issuePrefix: "RUN", issueId: "source", issueIdentifier: "RUN-3", chatAgentId: "actual-agent-uuid" })).toBe(false);
});
it("preserves the exact public capture callback and its rejection for all other ordinary chat suites", async () => {
  const privateCapture = vi.fn(async () => {}), publicCapture = vi.fn(async () => { throw new Error("Existing public guard rejection"); });
  const capture = ordinaryChatCapture("chat", privateCapture, publicCapture);
  expect(capture).toBe(publicCapture); await expect(capture("final", "Task", "final-state.png")).rejects.toThrow("Existing public guard rejection"); expect(privateCapture).not.toHaveBeenCalled();
});
it("keeps the required final-state file in real packaged Actions evidence while public history excludes its unmarked path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "private-chat-capture-")), upload = `${root}-upload`;
  try {
    for (const dir of ["snapshots", "html-report", "blob-report"]) await mkdir(path.join(root, dir));
    for (const [file, content] of Object.entries({ "result.json": "{}", "junit.xml": "<testsuite/>", "snapshots/fixtures.json": "{}", "snapshots/api-state.json": "{}", "html-report/index.html": "<html/>", "blob-report/receipt.txt": "synthetic unit fixture" })) await writeFile(path.join(root, file), content);
    await execFileAsync("zip", ["-q", "report.zip", "receipt.txt"], { cwd: path.join(root, "blob-report") }); await rm(path.join(root, "blob-report/receipt.txt"));
    const bytes = Buffer.from("unit PNG custody fixture");
    const capture = ordinaryChatCapture("chat-features", async (_id, file) => { await writeFile(path.join(root, file), bytes); }, async () => { throw new Error("Must remain private"); });
    await capture("final-state", "Real callback supplies the actual page screenshot", "final-state.png");
    const packaged = await packageEvidence({ privateDir: root, uploadDir: upload, secrets: [], expectPassScreenshot: true });
    expect(packaged.missing).toEqual([]); expect(await readFile(path.join(upload, "final-state.png"))).toEqual(bytes);
    expect(isHistoricalBundlePathAllowed("evidence/chat-features.runner-opencode.local.agent-chat.reopen-conversation/attempt-1/final-state.png", false, new Set())).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(upload, { recursive: true, force: true }); }
});
