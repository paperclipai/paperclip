import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { workFolderTransport } from "../services/work-folder-transport.js";
import { localTestWorkFolderRunner } from "./helpers/work-folder-runner.js";

const upstreamError = () => Object.assign(new Error("Request failed with status code 502"), { response: { status: 502 } });
type ExecuteInput = Parameters<typeof localTestWorkFolderRunner.execute>[0];
const request = (input: ExecuteInput) => JSON.parse(Buffer.from(input.args!.at(-1)!, "base64").toString());
const entry = { path: "nested/file", kind: "file" as const, byteSize: 3,
  sha256: createHash("sha256").update("new").digest("hex"), executable: true };

describe("work folder batch outcome recovery", () => {
  const roots: string[] = [];
  async function fixture() {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "work-folder-receipt-host-")));
    roots.push(root);
    const target = path.join(root, "task"), staging = path.join(root, "staging");
    await mkdir(target); await mkdir(staging);
    return { target, staging };
  }
  afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it("recovers a lost successful batch response without overwriting a subsequent local edit", async () => {
    const { target, staging } = await fixture();
    const execute = vi.fn(async (input: ExecuteInput) => {
      const result = await localTestWorkFolderRunner.execute(input);
      if (request(input).operation === "batch") {
        expect(result.exitCode).toBe(0);
        expect(await readFile(path.join(target, entry.path), "utf8")).toBe("new");
        await writeFile(path.join(target, entry.path), "later");
        throw upstreamError();
      }
      return result;
    });
    const transport = workFolderTransport({ execute, supportsSingleStreamStdinProgress: true });
    const beforePublish = vi.fn();
    await transport.writeMany(target, staging, (async function* () { yield { entry, body: Readable.from(["new"]) }; })(), beforePublish);
    expect(execute.mock.calls.map(([input]) => request(input).operation)).toEqual(["batch", "batch-status"]);
    expect(beforePublish).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(target, entry.path), "utf8")).toBe("later");
  });

  it("resubmits the same identity only when a lost request left no claim", async () => {
    const { target, staging } = await fixture();
    let initial = true;
    const execute = vi.fn(async (input: ExecuteInput) => {
      if (request(input).operation === "batch" && initial) { initial = false; throw upstreamError(); }
      return localTestWorkFolderRunner.execute(input);
    });
    await workFolderTransport({ execute, supportsSingleStreamStdinProgress: true })
      .write(target, staging, entry, Readable.from(["new"]));
    const requests = execute.mock.calls.map(([input]) => request(input));
    expect(requests.map((r) => r.operation)).toEqual(["batch", "batch-status", "batch"]);
    expect(new Set(requests.map((r) => r.batchId)).size).toBe(1);
    expect(new Set(requests.map((r) => r.batchReceiptKey)).size).toBe(1);
    expect(new Set(requests.map((r) => r.batchSha256)).size).toBe(1);
    expect(await readFile(path.join(target, entry.path), "utf8")).toBe("new");
  });

  it("preserves a claimed incomplete batch instead of retrying its mutations", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async (input: ExecuteInput) => ({ exitCode: 0, stderr: "", signal: null, timedOut: false,
      stdout: JSON.stringify(request(input).operation === "batch" ? { pending: true } : { state: "running" }) }));
    const pending = workFolderTransport({ execute, supportsSingleStreamStdinProgress: true })
      .write("/task", "/staging", entry, Readable.from(["new"]));
    const rejection = expect(pending).rejects.toThrow("outcome is uncertain");
    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;
    expect(execute.mock.calls.filter(([input]) => request(input).operation === "batch")).toHaveLength(1);
    expect(execute.mock.calls.length).toBeLessThanOrEqual(242);
  });

  it("bounds absent-claim retries and never retries a recorded failure", async () => {
    const execute = vi.fn(async (input: ExecuteInput) => {
      if (request(input).operation === "batch") throw upstreamError();
      return { exitCode: 0, stderr: "", signal: null, timedOut: false, stdout: JSON.stringify({ state: "missing" }) };
    });
    const transport = workFolderTransport({ execute, supportsSingleStreamStdinProgress: true });
    await expect(transport.write("/task", "/staging", entry, Readable.from(["new"]))).rejects.toThrow("502");
    expect(execute.mock.calls.filter(([input]) => request(input).operation === "batch")).toHaveLength(3);
    execute.mockClear();
    execute.mockImplementation(async (input: ExecuteInput) => {
      if (request(input).operation === "batch") throw upstreamError();
      return { exitCode: 0, stderr: "", signal: null, timedOut: false, stdout: JSON.stringify({ state: "failed", error: "batch_failed" }) };
    });
    await expect(transport.write("/task", "/staging", entry, Readable.from(["new"]))).rejects.toThrow("batch_failed");
    expect(execute.mock.calls.map(([input]) => request(input).operation)).toEqual(["batch", "batch-status"]);
  });
});
