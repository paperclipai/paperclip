import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  createNodeRunLogArchiverFs,
  createRunLogArchiver,
  type HeartbeatRunLogRow,
  type RunLogArchiverConfig,
  type RunLogArchiverDb,
  type RunLogArchiverStorage,
} from "../services/run-log-archiver.ts";

const NOW = new Date("2026-07-08T10:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * MS_PER_DAY);

const TERMINAL = new Set(["succeeded", "failed", "timed_out", "cancelled"]);
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

let base: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "run-log-archiver-"));
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function cfg(over: Partial<RunLogArchiverConfig> = {}): RunLogArchiverConfig {
  return {
    mode: "auto",
    storageEnabled: true,
    hotRetentionDays: 30,
    companyBudgetBytes: 5 * 1024 * 1024 * 1024,
    itemLimit: 200,
    ...over,
  };
}

function makeRow(over: Partial<HeartbeatRunLogRow> & Pick<HeartbeatRunLogRow, "id" | "logRef">): HeartbeatRunLogRow {
  return {
    companyId: "company-1",
    agentId: "agent-1",
    status: "succeeded",
    finishedAt: daysAgo(40),
    logStore: "local_file",
    ...over,
  };
}

/** In-memory DB port. Mutates the provided rows array on markArchivedToS3. */
function fakeDb(rows: HeartbeatRunLogRow[]): RunLogArchiverDb {
  const completedAt = (r: HeartbeatRunLogRow) => r.finishedAt ?? new Date(0);
  const eligible = (r: HeartbeatRunLogRow) =>
    r.logStore === "local_file" && !!r.logRef && TERMINAL.has(r.status);
  return {
    async selectAgeArchivable(cutoff, limit) {
      return rows
        .filter((r) => eligible(r) && completedAt(r) < cutoff)
        .sort((a, b) => completedAt(a).getTime() - completedAt(b).getTime())
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    async selectCompanyArchivableOldestFirst(companyId, limit) {
      return rows
        .filter((r) => r.companyId === companyId && eligible(r))
        .sort((a, b) => completedAt(a).getTime() - completedAt(b).getTime())
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    async markArchivedToS3(runId, objectKey) {
      const r = rows.find((x) => x.id === runId);
      if (r) {
        r.logStore = "s3";
        r.logRef = objectKey;
      }
    },
  };
}

interface FakeStorage extends RunLogArchiverStorage {
  objects: Map<string, Buffer>;
}

function fakeStorage(over?: Partial<RunLogArchiverStorage>): FakeStorage {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    putObject: vi.fn(async ({ objectKey, body }) => {
      objects.set(objectKey, Buffer.from(body));
    }),
    headObject: vi.fn(async ({ objectKey }) => {
      const buf = objects.get(objectKey);
      return buf ? { exists: true, contentLength: buf.length } : { exists: false };
    }),
    ...over,
  };
}

/** Write a gzipped run-log to disk under baseDir; return its posix logRef. */
async function seedGzLog(companyId: string, agentId: string, runId: string, content: string): Promise<string> {
  const relDir = path.join(companyId, agentId);
  await fs.mkdir(path.join(base, relDir), { recursive: true });
  const rel = path.join(relDir, `${runId}.ndjson.gz`);
  await fs.writeFile(path.join(base, rel), gzipSync(Buffer.from(content, "utf8")));
  return rel.split(path.sep).join("/");
}

const exists = async (rel: string) =>
  fs
    .stat(path.join(base, rel))
    .then(() => true)
    .catch(() => false);

describe("run-log-archiver archive flow", () => {
  it("archives an eligible old run: exact key, head-verified, DB flipped, local gone, dirs cleaned", async () => {
    const content = "line one\nline two\nline three\n";
    const logRef = await seedGzLog("company-1", "agent-1", "run-1", content);
    const rows = [makeRow({ id: "run-1", logRef, finishedAt: daysAgo(40) })];

    const db = fakeDb(rows);
    const storage = fakeStorage();
    const files = createNodeRunLogArchiverFs(base);
    const archiver = createRunLogArchiver({ db, storage, files, config: cfg(), now: () => NOW, log: silentLog });

    const res = await archiver.runSweep();

    expect(res.skipped).toBe(false);
    expect(res.ageArchived).toBe(1);
    expect(res.failed).toBe(0);

    const expectedKey = "run-logs/company-1/agent-1/run-1.ndjson.gz";
    expect(storage.putObject).toHaveBeenCalledTimes(1);
    expect(storage.headObject).toHaveBeenCalledTimes(1);
    expect(storage.objects.has(expectedKey)).toBe(true);
    // Uploaded object decompresses to the original content.
    expect(gunzipSync(storage.objects.get(expectedKey)!).toString("utf8")).toBe(content);

    // DB row flipped to the s3 tier + new logRef.
    expect(rows[0]!.logStore).toBe("s3");
    expect(rows[0]!.logRef).toBe(expectedKey);

    // Local file removed and now-empty parent dirs pruned.
    expect(await exists(logRef)).toBe(false);
    expect(await exists("company-1/agent-1")).toBe(false);
    expect(await exists("company-1")).toBe(false);
  });

  it("verify-failure (head size mismatch) keeps the local file and leaves the DB unchanged", async () => {
    const logRef = await seedGzLog("company-1", "agent-1", "run-1", "payload\n");
    const rows = [makeRow({ id: "run-1", logRef })];
    const storage = fakeStorage({
      // Report a wrong length so verify-before-delete refuses to flip the row.
      headObject: vi.fn(async () => ({ exists: true, contentLength: 999_999 })),
    });
    const archiver = createRunLogArchiver({
      db: fakeDb(rows),
      storage,
      files: createNodeRunLogArchiverFs(base),
      config: cfg(),
      now: () => NOW,
      log: silentLog,
    });

    const res = await archiver.runSweep();

    expect(res.ageArchived).toBe(0);
    expect(res.failed).toBe(1);
    expect(rows[0]!.logStore).toBe("local_file");
    expect(rows[0]!.logRef).toBe(logRef);
    expect(await exists(logRef)).toBe(true);
  });

  it("verify-failure (head throws) is swallowed: local kept, sweep continues", async () => {
    const logRef = await seedGzLog("company-1", "agent-1", "run-1", "payload\n");
    const rows = [makeRow({ id: "run-1", logRef })];
    const storage = fakeStorage({
      headObject: vi.fn(async () => {
        throw new Error("network blip");
      }),
    });
    const archiver = createRunLogArchiver({
      db: fakeDb(rows),
      storage,
      files: createNodeRunLogArchiverFs(base),
      config: cfg(),
      now: () => NOW,
      log: silentLog,
    });

    const res = await archiver.runSweep();
    expect(res.failed).toBe(1);
    expect(rows[0]!.logStore).toBe("local_file");
    expect(await exists(logRef)).toBe(true);
  });
});

describe("run-log-archiver age gate", () => {
  it("leaves a recent terminal run alone and never touches a running run", async () => {
    const recentRef = await seedGzLog("company-1", "agent-1", "recent", "recent output\n");
    // A huge running run: not terminal → must never be archived, regardless of size.
    const runningRef = await seedGzLog("company-1", "agent-1", "running", "x".repeat(10_000));
    const rows = [
      makeRow({ id: "recent", logRef: recentRef, status: "succeeded", finishedAt: daysAgo(5) }),
      makeRow({ id: "running", logRef: runningRef, status: "running", finishedAt: null }),
    ];

    const storage = fakeStorage();
    const archiver = createRunLogArchiver({
      db: fakeDb(rows),
      storage,
      files: createNodeRunLogArchiverFs(base),
      // Budget high so only the age gate is in play.
      config: cfg({ companyBudgetBytes: 1024 * 1024 * 1024 }),
      now: () => NOW,
      log: silentLog,
    });

    const res = await archiver.runSweep();

    expect(res.ageArchived).toBe(0);
    expect(res.fairnessArchived).toBe(0);
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(rows.every((r) => r.logStore === "local_file")).toBe(true);
    expect(await exists(recentRef)).toBe(true);
    expect(await exists(runningRef)).toBe(true);
  });
});

describe("run-log-archiver fairness budget", () => {
  it("archives an over-budget company's oldest terminal runs until under budget; skips running; leaves other companies", async () => {
    const content = "same size payload for every run so gz sizes match\n";
    // company-1: 3 terminal (all recent → age gate would skip) + 1 running.
    const oldest = await seedGzLog("company-1", "agent-1", "t-oldest", content);
    const middle = await seedGzLog("company-1", "agent-1", "t-middle", content);
    const newest = await seedGzLog("company-1", "agent-1", "t-newest", content);
    const running = await seedGzLog("company-1", "agent-1", "r-running", content);
    // company-2: one terminal run, well under budget → untouched.
    const other = await seedGzLog("company-2", "agent-9", "t-other", content);

    const oneSize = (await fs.stat(path.join(base, oldest))).size;

    const rows = [
      makeRow({ id: "t-oldest", logRef: oldest, finishedAt: daysAgo(3) }),
      makeRow({ id: "t-middle", logRef: middle, finishedAt: daysAgo(2) }),
      makeRow({ id: "t-newest", logRef: newest, finishedAt: daysAgo(1) }),
      makeRow({ id: "r-running", logRef: running, status: "running", finishedAt: null }),
      makeRow({ id: "t-other", companyId: "company-2", agentId: "agent-9", logRef: other, finishedAt: daysAgo(1) }),
    ];

    const storage = fakeStorage();
    const archiver = createRunLogArchiver({
      db: fakeDb(rows),
      storage,
      files: createNodeRunLogArchiverFs(base),
      // company-1 holds 4 files (4*oneSize). Budget = 2*oneSize forces archiving
      // the 2 oldest terminal runs (running is skipped) to get down to 2*oneSize.
      // Retention high so the age pass archives nothing.
      config: cfg({ companyBudgetBytes: 2 * oneSize, hotRetentionDays: 3650 }),
      now: () => NOW,
      log: silentLog,
    });

    const res = await archiver.runSweep();

    expect(res.fairnessArchived).toBe(2);
    expect(res.ageArchived).toBe(0);

    // Oldest two terminal runs archived.
    expect(rows.find((r) => r.id === "t-oldest")!.logStore).toBe("s3");
    expect(rows.find((r) => r.id === "t-middle")!.logStore).toBe("s3");
    // Newest terminal + running left hot; running never archived.
    expect(rows.find((r) => r.id === "t-newest")!.logStore).toBe("local_file");
    expect(rows.find((r) => r.id === "r-running")!.logStore).toBe("local_file");
    expect(await exists(running)).toBe(true);
    expect(await exists(newest)).toBe(true);

    // Other company untouched.
    expect(rows.find((r) => r.id === "t-other")!.logStore).toBe("local_file");
    expect(await exists(other)).toBe(true);
  });
});

describe("run-log-archiver disabled", () => {
  it("no-ops when storage is unavailable (auto + local_disk provider)", async () => {
    const logRef = await seedGzLog("company-1", "agent-1", "run-1", "payload\n");
    const rows = [makeRow({ id: "run-1", logRef })];
    const storage = fakeStorage();
    const archiver = createRunLogArchiver({
      db: fakeDb(rows),
      storage,
      files: createNodeRunLogArchiverFs(base),
      config: cfg({ mode: "auto", storageEnabled: false }),
      now: () => NOW,
      log: silentLog,
    });

    const res = await archiver.runSweep();

    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("storage_unavailable");
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(rows[0]!.logStore).toBe("local_file");
    expect(await exists(logRef)).toBe(true);
  });

  it("no-ops when mode is off even if storage is available", async () => {
    const logRef = await seedGzLog("company-1", "agent-1", "run-1", "payload\n");
    const rows = [makeRow({ id: "run-1", logRef })];
    const storage = fakeStorage();
    const archiver = createRunLogArchiver({
      db: fakeDb(rows),
      storage,
      files: createNodeRunLogArchiverFs(base),
      config: cfg({ mode: "off", storageEnabled: true }),
      now: () => NOW,
      log: silentLog,
    });

    const res = await archiver.runSweep();
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("mode_off");
    expect(storage.putObject).not.toHaveBeenCalled();
  });
});
