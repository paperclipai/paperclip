import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => ({ track: vi.fn() }) }));
vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child(this: unknown) {
      return this;
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  httpLogger: vi.fn(),
}));

import { createManagedAiHomeRemovalGate, heartbeatService } from "../services/heartbeat.ts";
import { sweepOrphanedRunScratchDirectories } from "../services/heartbeat/recovery.js";
import { isProcessGroupAlive } from "../services/local-service-supervisor.js";
import { HEARTBEAT_RUN_SCRATCH_MARKER } from "../services/run-scratch.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat recovery sweeps orphaned run scratch", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let originalTmpdir: string | undefined;
  let scratchRoot = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-scratch-recovery-");
    db = createDb(tempDb.connectionString);
    originalTmpdir = process.env.TMPDIR;
    scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-scratch-root-"));
    process.env.TMPDIR = scratchRoot;
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    await fs.rm(scratchRoot, { recursive: true, force: true });
    await fs.mkdir(scratchRoot, { recursive: true });
  });

  afterAll(async () => {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    await fs.rm(scratchRoot, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function seedRun(status: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status,
      nextEventSeq: 1,
    });
    return { companyId, agentId, runId };
  }

  async function leaveScratch(run: { companyId: string; agentId: string; runId: string }, runIdInMarker = run.runId) {
    const dir = await fs.mkdtemp(path.join(scratchRoot, `paperclip-run-x-${run.runId.slice(0, 12)}-`));
    await fs.writeFile(
      path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
      JSON.stringify({
        version: 1,
        companyId: run.companyId,
        agentId: run.agentId,
        runId: runIdInMarker,
        issueId: null,
        issueIdentifier: null,
        createdAt: new Date().toISOString(),
      }),
    );
    return dir;
  }

  const exists = (p: string) => fs.stat(p).then(() => true, () => false);

  it("removes a terminal run's leftover directory and keeps others, even beside a malformed marker", async () => {
    const terminal = await seedRun("failed");
    const queued = await seedRun("queued");
    const terminalDir = await leaveScratch(terminal);
    const queuedDir = await leaveScratch(queued);
    const malformedDir = await leaveScratch(terminal, "not-a-uuid");
    const unknownRunDir = await leaveScratch(terminal, randomUUID());
    const unmarkedDir = await fs.mkdtemp(path.join(scratchRoot, "paperclip-run-x-unmarked-"));

    await heartbeatService(db).reapOrphanedRuns();

    expect(await exists(terminalDir)).toBe(false);
    expect(await exists(queuedDir)).toBe(true);
    expect(await exists(malformedDir)).toBe(true);
    expect(await exists(unknownRunDir)).toBe(true);
    expect(await exists(unmarkedDir)).toBe(true);
  });

  it("reclaims orphaned scratch when the periodic sweep worker calls the extracted sweep directly", async () => {
    const terminal = await seedRun("failed");
    const queued = await seedRun("queued");
    const terminalDir = await leaveScratch(terminal);
    const queuedDir = await leaveScratch(queued);

    // The production worker invokes this standalone function on its schedule;
    // it must resolve run states and liveness from the database on its own.
    await sweepOrphanedRunScratchDirectories(db);

    expect(await exists(terminalDir)).toBe(false);
    expect(await exists(queuedDir)).toBe(true);
  });
});

describe("managed AI home removal gate", () => {
  const gateFor = (getRun: () => Promise<{ processGroupId: number | null } | null>) =>
    createManagedAiHomeRemovalGate({ runId: randomUUID(), getRun, isProcessGroupAlive });

  it("never turns a failed run read into removal consent while the process group is alive", async () => {
    // Real detached process group with a natural exit, like a run descendant.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const processGroupId = child.pid!;
    expect(isProcessGroupAlive(processGroupId)).toBe(true);

    // A failed run read rejects instead of allowing the removal.
    await expect(gateFor(() => Promise.reject(new Error("db read failed")))()).rejects.toThrow("db read failed");
    // A verified live process group keeps the home.
    await expect(gateFor(() => Promise.resolve({ processGroupId }))()).resolves.toBe(false);

    // After the natural exit, a successful read allows the removal.
    const deadline = Date.now() + 15_000;
    while (isProcessGroupAlive(processGroupId)) {
      if (Date.now() > deadline) throw new Error("process group did not exit naturally");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await expect(gateFor(() => Promise.resolve({ processGroupId }))()).resolves.toBe(true);
    // A successful read of a deleted run row has no group to protect.
    await expect(gateFor(() => Promise.resolve(null))()).resolves.toBe(true);
  });
});
