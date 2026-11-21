import { spawn, type ChildProcess } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import {
  forgetTrackedRunLineageForTests,
  reapRunDescendants,
  registeredServiceExclusions,
  setRunLineageSampleIntervalForTests,
  trackRunDescendants,
} from "./run-descendant-reaper.js";

describe("registeredServiceExclusions", () => {
  const recordedAt = "2026-01-01T00:00:10.000Z";
  const recordedAtMs = Date.parse(recordedAt);

  it("excludes a service PID and group that started before the record", () => {
    const starts = new Map([[100, recordedAtMs - 60_000]]);
    expect(
      registeredServiceExclusions([{ pid: 100, processGroupId: 100, startedAt: recordedAt }], (pid) => starts.get(pid) ?? null),
    ).toEqual({ pids: [100], processGroupIds: [100] });
  });

  it("does not exclude a PID or group leader reused after the record was written", () => {
    const starts = new Map([[100, recordedAtMs + 60_000]]);
    expect(
      registeredServiceExclusions([{ pid: 100, processGroupId: 100, startedAt: recordedAt }], (pid) => starts.get(pid) ?? null),
    ).toEqual({ pids: [], processGroupIds: [] });
  });

  it("keeps a group whose leader is gone, and drops a gone PID", () => {
    expect(
      registeredServiceExclusions([{ pid: 100, processGroupId: 100, startedAt: recordedAt }], () => null),
    ).toEqual({ pids: [], processGroupIds: [100] });
  });

  it("does not exclude anything for a record with an unreadable start time", () => {
    expect(
      registeredServiceExclusions([{ pid: 100, processGroupId: null, startedAt: "not a date" }], () => recordedAtMs),
    ).toEqual({ pids: [], processGroupIds: [] });
  });
});

describe.skipIf(process.platform !== "linux")("run lineage file", () => {
  const children: ChildProcess[] = [];
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    previousHome = process.env.PAPERCLIP_HOME;
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "pc-lineage-"));
    process.env.PAPERCLIP_HOME = home;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setRunLineageSampleIntervalForTests(null);
    forgetTrackedRunLineageForTests();
    for (const child of children.splice(0)) child.kill("SIGKILL");
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await fsp.rm(home, { recursive: true, force: true });
  });

  function startSleeper() {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    children.push(child);
    return child.pid!;
  }

  const lineageFile = (runId: string) => path.join(resolvePaperclipInstanceRoot(), "run-lineage", `${runId}.json`);
  const savedPids = async (runId: string) =>
    (JSON.parse(await fsp.readFile(lineageFile(runId), "utf8")) as { entries: Array<{ pid: number }> }).entries
      .map((entry) => entry.pid)
      .sort((a, b) => a - b);

  async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  it("retries a failed save on a later sample when nothing changed again", async () => {
    const runId = "lineage-retry-run";
    const root = resolvePaperclipInstanceRoot();
    await fsp.mkdir(root, { recursive: true });
    // A plain file where the lineage directory belongs makes the save fail.
    await fsp.writeFile(path.join(root, "run-lineage"), "");
    setRunLineageSampleIntervalForTests(20);
    const pid = startSleeper();
    await trackRunDescendants({ runId, rootPid: pid });
    await expect(fsp.stat(lineageFile(runId))).rejects.toThrow();

    await fsp.rm(path.join(root, "run-lineage"));
    expect(await waitFor(async () => fsp.stat(lineageFile(runId)).then(() => true, () => false))).toBe(true);
    expect(await savedPids(runId)).toEqual([pid]);

    await reapRunDescendants({ runId, graceMs: 200, reason: "test" });
  });

  it("writes one run's saves one at a time, each from its own temporary file", async () => {
    const runId = "lineage-serial-run";
    setRunLineageSampleIntervalForTests(60_000);
    const realWriteFile = fsp.writeFile.bind(fsp);
    const tmpNames: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(fsp, "writeFile").mockImplementation(async (file, data, options) => {
      if (String(file).includes(`${runId}.json`)) {
        tmpNames.push(String(file));
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          return await realWriteFile(file, data, options);
        } finally {
          inFlight -= 1;
        }
      }
      return realWriteFile(file, data, options);
    });

    const first = startSleeper();
    const second = startSleeper();
    const firstTrack = trackRunDescendants({ runId, rootPid: first });
    expect(await waitFor(() => tmpNames.length === 1)).toBe(true);
    // A second root is recorded while the first save is still being written.
    await Promise.all([firstTrack, trackRunDescendants({ runId, rootPid: second })]);

    expect(maxInFlight).toBe(1);
    expect(new Set(tmpNames).size).toBe(tmpNames.length);
    expect(await savedPids(runId)).toEqual([first, second].sort((a, b) => a - b));

    vi.restoreAllMocks();
    const result = await reapRunDescendants({ runId, graceMs: 200, reason: "test" });
    expect(result?.survivors ?? []).toEqual([]);
    await expect(fsp.stat(lineageFile(runId))).rejects.toThrow();
  });
});
