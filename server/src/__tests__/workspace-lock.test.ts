import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, workspaceLocks } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  acquireWorkspaceLock,
  countActiveWorkspaceLocks,
  getWorkspaceLockHolder,
  normalizeWorkspaceCwd,
  releaseWorkspaceLock,
  sweepStaleWorkspaceLockForCwd,
} from "../services/workspace-lock.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workspace-lock tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("workspace-lock service (RUN-21)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-lock-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "WS Lock Co",
      slug: `wslock-${companyId.slice(0, 8)}`,
    });

    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "WS Lock Agent",
      adapterType: "noop",
    });
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(workspaceLocks);
    await db.delete(heartbeatRuns);
  });

  async function makeRun(): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: {},
    });
    return id;
  }

  it("normalizeWorkspaceCwd resolves relative paths to absolute paths", () => {
    expect(normalizeWorkspaceCwd("/abs/path")).toBe("/abs/path");
    expect(normalizeWorkspaceCwd("/abs/path/")).toBe("/abs/path");
    expect(normalizeWorkspaceCwd("/abs/path/.")).toBe("/abs/path");
    expect(normalizeWorkspaceCwd("/abs/foo/../bar")).toBe("/abs/bar");
    expect(() => normalizeWorkspaceCwd("")).toThrow();
  });

  it("acquires a lock for a fresh cwd and rejects a sibling on the same cwd", async () => {
    const cwd = "/test/repo/site";
    const expiresAt = new Date(Date.now() + 60_000);

    const runA = await makeRun();
    const runB = await makeRun();

    const first = await acquireWorkspaceLock(db, {
      companyId,
      cwdPath: cwd,
      runId: runA,
      agentId,
      issueId: null,
      expiresAt,
    });
    expect(first.acquired).toBe(true);

    const second = await acquireWorkspaceLock(db, {
      companyId,
      cwdPath: cwd,
      runId: runB,
      agentId,
      issueId: null,
      expiresAt,
    });
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.holder.runId).toBe(runA);
      expect(second.holder.cwdPath).toBe(cwd);
    }

    expect(await countActiveWorkspaceLocks(db)).toBe(1);
  });

  it("releases a lock and lets the next run acquire", async () => {
    const cwd = "/test/repo/release";
    const expiresAt = new Date(Date.now() + 60_000);

    const runA = await makeRun();
    const runB = await makeRun();

    const acquireA = await acquireWorkspaceLock(db, {
      companyId,
      cwdPath: cwd,
      runId: runA,
      agentId,
      issueId: null,
      expiresAt,
    });
    expect(acquireA.acquired).toBe(true);

    const released = await releaseWorkspaceLock(db, runA);
    expect(released?.cwdPath).toBe(cwd);

    expect(await getWorkspaceLockHolder(db, cwd)).toBeNull();

    const acquireB = await acquireWorkspaceLock(db, {
      companyId,
      cwdPath: cwd,
      runId: runB,
      agentId,
      issueId: null,
      expiresAt,
    });
    expect(acquireB.acquired).toBe(true);
  });

  it("releaseWorkspaceLock is idempotent when no lock is held", async () => {
    const runA = await makeRun();
    const released = await releaseWorkspaceLock(db, runA);
    expect(released).toBeNull();
  });

  it("reclaims an expired lock on the next acquire (stale-sweep)", async () => {
    const cwd = "/test/repo/stale";
    const longGone = new Date(Date.now() - 5 * 60_000);
    const fresh = new Date(Date.now() + 60_000);

    const staleRun = await makeRun();
    const freshRun = await makeRun();

    // Insert a stale lock manually so we don't need to fake a clock for the sweep.
    await db.insert(workspaceLocks).values({
      companyId,
      cwdPath: cwd,
      runId: staleRun,
      agentId,
      issueId: null,
      acquiredAt: new Date(Date.now() - 60 * 60_000),
      expiresAt: longGone,
    });

    const reclaimed = await sweepStaleWorkspaceLockForCwd(db, cwd);
    expect(reclaimed?.runId).toBe(staleRun);

    const acquired = await acquireWorkspaceLock(db, {
      companyId,
      cwdPath: cwd,
      runId: freshRun,
      agentId,
      issueId: null,
      expiresAt: fresh,
    });
    expect(acquired.acquired).toBe(true);
  });

  it("acquireWorkspaceLock auto-sweeps stale locks before contention check", async () => {
    const cwd = "/test/repo/auto-sweep";
    const longGone = new Date(Date.now() - 5 * 60_000);
    const fresh = new Date(Date.now() + 60_000);

    const staleRun = await makeRun();
    const newRun = await makeRun();

    await db.insert(workspaceLocks).values({
      companyId,
      cwdPath: cwd,
      runId: staleRun,
      agentId,
      issueId: null,
      acquiredAt: new Date(Date.now() - 60 * 60_000),
      expiresAt: longGone,
    });

    const acquired = await acquireWorkspaceLock(db, {
      companyId,
      cwdPath: cwd,
      runId: newRun,
      agentId,
      issueId: null,
      expiresAt: fresh,
    });
    expect(acquired.acquired).toBe(true);
    if (acquired.acquired) {
      expect(acquired.staleReclaimed?.runId).toBe(staleRun);
    }
  });

  it("does not reclaim a still-fresh lock", async () => {
    const cwd = "/test/repo/fresh";
    const fresh = new Date(Date.now() + 60_000);

    const runA = await makeRun();
    const runB = await makeRun();

    await acquireWorkspaceLock(db, {
      companyId,
      cwdPath: cwd,
      runId: runA,
      agentId,
      issueId: null,
      expiresAt: fresh,
    });

    const reclaimed = await sweepStaleWorkspaceLockForCwd(db, cwd);
    expect(reclaimed).toBeNull();

    const second = await acquireWorkspaceLock(db, {
      companyId,
      cwdPath: cwd,
      runId: runB,
      agentId,
      issueId: null,
      expiresAt: fresh,
    });
    expect(second.acquired).toBe(false);
  });

  it("the same run cannot hold two locks (run_id unique)", async () => {
    const runA = await makeRun();
    const fresh = new Date(Date.now() + 60_000);

    const first = await acquireWorkspaceLock(db, {
      companyId,
      cwdPath: "/test/repo/path-1",
      runId: runA,
      agentId,
      issueId: null,
      expiresAt: fresh,
    });
    expect(first.acquired).toBe(true);

    await expect(
      acquireWorkspaceLock(db, {
        companyId,
        cwdPath: "/test/repo/path-2",
        runId: runA,
        agentId,
        issueId: null,
        expiresAt: fresh,
      }),
    ).rejects.toThrow();
  });
});
