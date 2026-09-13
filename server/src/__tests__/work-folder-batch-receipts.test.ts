import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink, link, readdir } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { localTestWorkFolderRunner } from "./helpers/work-folder-runner.js";

const source = await readFile(new URL("../services/scripts/work-folder-io.mjs", import.meta.url), "utf8");
const sha = (body: string) => createHash("sha256").update(body).digest("hex");
type Envelope = { operation: string; root: string; stagingRoot: string; batchId: string; batchSha256: string; batchReceiptKey: string };
const roots: string[] = [], children = new Set<ChildProcess>();
async function fixture(operations: Record<string, unknown>[] = [{ operation: "write", path: "piece", offset: 0, data: Buffer.from("old").toString("base64") },
  { operation: "publish", path: "file", stagingPath: "piece", sha256: sha("old"), executable: false }]) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "work-folder-receipt-")));
  roots.push(directory);
  const root = path.join(directory, "task"), stagingRoot = path.join(directory, "staging");
  await mkdir(root); await mkdir(stagingRoot);
  const body = JSON.stringify(operations);
  const request: Envelope = { operation: "batch", root, stagingRoot, batchId: randomUUID(), batchSha256: sha(body), batchReceiptKey: randomBytes(32).toString("hex") };
  return { directory, request, body, receipt: path.join(stagingRoot, ".batch-receipts", request.batchId) };
}
async function invoke(request: Envelope, body?: string) {
  return localTestWorkFolderRunner.execute({ command: process.execPath,
    args: ["--input-type=module", "-e", source, Buffer.from(JSON.stringify(request)).toString("base64")],
    ...(body === undefined ? {} : { stdin: body }), timeoutMs: 5000 });
}
async function status(request: Envelope) {
  const result = await invoke({ ...request, operation: "batch-status" });
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
async function successful(request: Envelope, body: string) {
  const result = await invoke(request, body);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.kill("SIGKILL"); await closed;
  }
  children.clear();
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("bulk work-folder receipts in the actual sandbox IO script", () => {
  it("reports missing without creating receipt directories", async () => {
    const f = await fixture();
    expect(await status(f.request)).toEqual({ state: "missing" });
    expect(await readdir(f.request.stagingRoot)).toEqual([]);
  });
  it("returns the original count after a lost response without overwriting a later edit", async () => {
    const f = await fixture();
    // Discarding this response models a provider response lost after execution.
    await successful(f.request, f.body);
    await writeFile(path.join(f.request.root, "file"), "later agent edit");
    expect(await status(f.request)).toEqual({ state: "completed", completed: 2 });
    expect(await successful(f.request, f.body)).toEqual({ completed: 2 });
    expect(await readFile(path.join(f.request.root, "file"), "utf8")).toBe("later agent edit");
    expect(await readdir(f.request.stagingRoot)).toEqual([".batch-receipts"]);
    expect(await readFile(f.receipt, "utf8")).not.toContain(f.request.batchReceiptKey);
  });
  it("atomically claims concurrent duplicate submissions", async () => {
    const f = await fixture();
    const outcomes = await Promise.all([successful(f.request, f.body), successful(f.request, f.body)]);
    expect(outcomes.some(value => value.completed === 2)).toBe(true);
    expect(outcomes.every(value => value.completed === 2 || value.pending === true)).toBe(true);
    expect(await status(f.request)).toEqual({ state: "completed", completed: 2 });
    expect(await readFile(path.join(f.request.root, "file"), "utf8")).toBe("old");
  });
  it("never replays a running or crashed batch after its exclusive claim", async () => {
    const f = await fixture(), marker = path.join(f.directory, "entered-operation");
    // Instrument only the subprocess test source: stop after the real signed
    // claim, before the first real write. Production has no fault/test hook.
    const stalled = source.replace("function execute(request) {", `function execute(request) {\nif (request.operation === "write") { fs.writeFileSync(${JSON.stringify(marker)}, "entered"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }`);
    const child = spawn(process.execPath, ["--input-type=module", "-e", stalled, Buffer.from(JSON.stringify(f.request)).toString("base64")], { stdio: ["pipe", "ignore", "ignore"] });
    children.add(child); child.stdin.end(f.body);
    const end = Date.now() + 5000;
    while (true) { try { await readFile(marker); break; } catch { if (Date.now() > end) throw new Error("Child did not reach mutation barrier"); await delay(10); } }
    expect(await status(f.request)).toEqual({ state: "running" });
    expect(await successful(f.request, f.body)).toEqual({ pending: true });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill("SIGKILL"); await closed; children.delete(child);
    expect(await status(f.request)).toEqual({ state: "running" });
    expect(await successful(f.request, f.body)).toEqual({ pending: true });
    expect(await readdir(f.request.root)).toEqual([]);
  });
  it("treats an empty interrupted claim as pending, never completed or replayable", async () => {
    const f = await fixture(); await mkdir(path.dirname(f.receipt)); await writeFile(f.receipt, "");
    expect(await status(f.request)).toEqual({ state: "running" });
    expect(await successful(f.request, f.body)).toEqual({ pending: true });
    expect(await readdir(f.request.root)).toEqual([]);
  });
  it("verifies exact stdin bytes before creating a claim or mutating files", async () => {
    const f = await fixture(); const result = await invoke(f.request, f.body + " ");
    expect(result.exitCode).not.toBe(0); expect(result.stderr).toContain("batch_body_hash_mismatch");
    expect(await status(f.request)).toEqual({ state: "missing" });
    expect(await readdir(f.request.root)).toEqual([]);
  });
  it("rejects the same ID with different body, root, or signing key", async () => {
    const f = await fixture(); await successful(f.request, f.body);
    const body = JSON.stringify([{ operation: "mkdir", path: "other" }]);
    const different = await invoke({ ...f.request, batchSha256: sha(body) }, body);
    expect(different.exitCode).not.toBe(0); expect(different.stderr).toContain("batch_receipt_identity_mismatch");
    const otherRoot = path.join(f.directory, "other"); await mkdir(otherRoot);
    for (const request of [{ ...f.request, root: otherRoot }, { ...f.request, batchReceiptKey: randomBytes(32).toString("hex") }]) {
      expect((await invoke({ ...request, operation: "batch-status" })).exitCode).not.toBe(0);
    }
    expect(await readFile(path.join(f.request.root, "file"), "utf8")).toBe("old");
    expect(await readdir(otherRoot)).toEqual([]);
  });
  it("binds receipts to staging root as well as task root", async () => {
    const f = await fixture(); await successful(f.request, f.body);
    const stagingRoot = path.join(f.directory, "other-stage"); await mkdir(path.join(stagingRoot, ".batch-receipts"), { recursive: true });
    await writeFile(path.join(stagingRoot, ".batch-receipts", f.request.batchId), await readFile(f.receipt));
    const result = await invoke({ ...f.request, operation: "batch-status", stagingRoot });
    expect(result.exitCode).not.toBe(0); expect(result.stderr).toContain("batch_receipt_identity_mismatch");
  });
  it.each(["completed", "extra", "signature", "malformed", "oversized"])("rejects forged or corrupted %s receipts", async corruption => {
    const f = await fixture(); await successful(f.request, f.body);
    const receipt = JSON.parse(await readFile(f.receipt, "utf8"));
    if (corruption === "completed") receipt.completed = 1;
    if (corruption === "extra") receipt.ignored = true;
    if (corruption === "signature") receipt.signature = "0".repeat(64);
    await writeFile(f.receipt, corruption === "malformed" ? "{" : corruption === "oversized" ? " ".repeat(5000) : JSON.stringify(receipt));
    const result = await invoke({ ...f.request, operation: "batch-status" });
    expect(result.exitCode).not.toBe(0); expect(result.stderr).toContain("invalid_batch_receipt");
    expect((await invoke(f.request, f.body)).exitCode).not.toBe(0);
  });
  it("records failure after a partial batch and refuses replay even if the cause is repaired", async () => {
    const operations = [{ operation: "write", path: "piece", offset: 0, data: Buffer.from("old").toString("base64") },
      { operation: "publish", path: "file", stagingPath: "piece", sha256: sha("wrong"), executable: false }];
    const f = await fixture(operations); const failure = await invoke(f.request, f.body);
    expect(failure.exitCode).not.toBe(0); expect(failure.stderr).toContain("content_changed_during_transfer");
    expect(await status(f.request)).toEqual({ state: "failed", error: "batch_execution_failed" });
    await writeFile(path.join(f.request.stagingRoot, "piece"), "wrong");
    expect((await invoke(f.request, f.body)).exitCode).not.toBe(0);
    expect(await readdir(f.request.root)).toEqual([]);
    expect(await readFile(path.join(f.request.stagingRoot, "piece"), "utf8")).toBe("wrong");
  });
  it.each(["receipt-symlink", "receipt-hardlink", "parent-symlink", "staging-symlink"])("rejects %s without touching the target", async variant => {
    const f = await fixture(), outside = path.join(f.directory, "outside"); await mkdir(outside);
    const secret = path.join(outside, "private"); await writeFile(secret, "untouched");
    let request = f.request;
    if (variant === "receipt-symlink" || variant === "receipt-hardlink") {
      await mkdir(path.dirname(f.receipt));
      if (variant === "receipt-symlink") await symlink(secret, f.receipt); else await link(secret, f.receipt);
    } else if (variant === "parent-symlink") await symlink(outside, path.dirname(f.receipt));
    else { const alias = path.join(f.directory, "stage-alias"); await symlink(f.request.stagingRoot, alias); request = { ...request, stagingRoot: alias }; }
    expect((await invoke({ ...request, operation: "batch-status" })).exitCode).not.toBe(0);
    expect((await invoke(request, f.body)).exitCode).not.toBe(0);
    expect(await readFile(secret, "utf8")).toBe("untouched");
  });
  it.each([
    { operation: "write", path: ".batch-receipts/forged", offset: 0, data: "" },
    { operation: "publish", path: "file", stagingPath: ".batch-receipts/forged", sha256: sha(""), executable: false },
    { operation: "mkdir", path: "file", root: "/tmp" },
    { operation: "write", path: "file", offset: 0, data: "", stagingRoot: "/tmp" },
    { operation: "write", path: "../outside", offset: 0, data: "" },
  ])("rejects reserved paths or body-authored roots before claiming: $operation $path", async operation => {
    const f = await fixture([operation]); expect((await invoke(f.request, f.body)).exitCode).not.toBe(0);
    expect(await status(f.request)).toEqual({ state: "missing" });
    expect(await readdir(f.request.root)).toEqual([]);
  });
});
