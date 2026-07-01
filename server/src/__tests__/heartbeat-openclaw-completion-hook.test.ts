import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const adapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  sessionParams: { sessionId: "session-1" },
  sessionDisplayId: "session-1",
  provider: "test",
  model: "test-model",
  summary: "test completion summary",
  resultJson: { summary: "test completion summary" },
})));

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres OpenClaw completion hook tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat OpenClaw completion hook", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("heartbeat-openclaw-completion-hook");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(() => {
    adapterExecute.mockClear();
    spawnMock.mockReset();
  });

  afterAll(async () => {
    await stopDb?.();
  });

  function mockSpawnSuccess() {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        once: (event: string, listener: (...args: any[]) => void) => any;
      };
      process.nextTick(() => child.emit("exit", 0));
      return child;
    });
  }

  function mockSpawnFailure() {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        once: (event: string, listener: (...args: any[]) => void) => any;
      };
      process.nextTick(() => child.emit("error", new Error("spawn failed")));
      return child;
    });
  }

  function mockSpawnHang() {
    const kill = vi.fn();
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & ChildProcess & {
        once: (event: string, listener: (...args: any[]) => void) => any;
        kill: typeof kill;
      };
      child.kill = kill;
      return child;
    });
    return { kill };
  }

  let fixtureCounter = 0;

  async function createAgentFixture() {
    fixtureCounter += 1;
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Acme ${fixtureCounter}`,
      issuePrefix: `T${fixtureCounter}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { companyId, agentId };
  }

  it("dispatches an OpenClaw completion event and marks the run result when the hook succeeds", async () => {
    mockSpawnSuccess();
    const { agentId } = await createAgentFixture();
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).toBe("succeeded");
      expect((latest?.resultJson as Record<string, unknown> | null)?.openclawCompletionHookSent).toBe(true);
    }, { timeout: 5_000 });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, options] = spawnMock.mock.calls[0] ?? [];
    expect(bin).toBe(process.execPath);
    expect(args).toEqual([
      "/usr/local/lib/node_modules/openclaw/openclaw.mjs",
      "system",
      "event",
      "--text",
      "Paperclip done: test completion summary",
      "--mode",
      "now",
    ]);
    expect(options).toMatchObject({
      stdio: "ignore",
      detached: false,
      env: expect.objectContaining({
        NODE: process.execPath,
      }),
    });
  });

  it("does not fail the heartbeat run when OpenClaw completion dispatch fails", async () => {
    mockSpawnFailure();
    const { agentId } = await createAgentFixture();
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).toBe("succeeded");
      expect(spawnMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 5_000 });

    const persisted = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)).then((rows) => rows[0] ?? null);
    expect(persisted?.status).toBe("succeeded");
    expect((persisted?.resultJson as Record<string, unknown> | null)?.openclawCompletionHookSent).not.toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("times out a hung OpenClaw completion dispatch without blocking heartbeat finalization", async () => {
    const { kill } = mockSpawnHang();
    const { agentId } = await createAgentFixture();
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(latest?.status).toBe("succeeded");
      expect(spawnMock.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(kill).toHaveBeenCalledTimes(1);
    }, { timeout: 10_000 });

    const persisted = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)).then((rows) => rows[0] ?? null);
    expect(persisted?.status).toBe("succeeded");
    expect((persisted?.resultJson as Record<string, unknown> | null)?.openclawCompletionHookSent).not.toBe(true);
  }, 15_000);
});
