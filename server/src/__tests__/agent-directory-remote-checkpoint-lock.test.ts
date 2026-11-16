import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { agents, authUsers, closeFileStorageDb, companies, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns,
  principalPermissionGrants } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";

const execFile = promisify(execFileCallback);

describe("remote agent directory checkpoint locking", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let observer: ReturnType<typeof createDb>;
  let home: string, companyId: string, agentId: string, userId: string, root: string, remoteCwd: string;
  const entryFile = "AGENTS.md";
  const runnerDelay = { ms: 0 };
  const calls: Array<{ checkpointScript: boolean; directoryLockHeld: boolean }> = [];
  let gate: { opened: Promise<void>; reached: () => void; reachedPromise: Promise<void> } | null = null;

  async function directoryLockHeld(): Promise<boolean> {
    const key = `agent-directory:${companyId}:${agentId}`;
    const [row] = await observer.execute<{ held: number }>(sql`select count(*)::int as held from pg_locks
      where locktype = 'advisory' and granted and objsubid = 1
        and ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)`);
    return Number(row?.held ?? 0) > 0;
  }

  const runner: CommandManagedRuntimeRunner = {
    execute: async input => {
      const startedAt = new Date().toISOString();
      const env = { ...process.env, ...input.env };
      const args = [...(input.args ?? [])];
      const checkpointScript = args.some(arg => arg.includes("--checkpoint"));
      calls.push({ checkpointScript, directoryLockHeld: await directoryLockHeld() });
      if (checkpointScript && gate) {
        const current = gate;
        gate = null;
        current.reached();
        await current.opened;
      }
      if (runnerDelay.ms) await new Promise(resolve => setTimeout(resolve, runnerDelay.ms));
      if (input.stdin != null && (args[0] === "-c" || args[0] === "-lc")) {
        env.PAPERCLIP_TEST_STDIN = input.stdin;
        args[1] = `printf '%s' "$PAPERCLIP_TEST_STDIN" | (${args[1]})`;
      }
      try {
        const result = await execFile(input.command, args, { cwd: input.cwd, env, timeout: input.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr, pid: null, startedAt };
      } catch (error) {
        const e = error as { code?: number; signal?: NodeJS.Signals; stdout?: string; stderr?: string };
        return { exitCode: typeof e.code === "number" ? e.code : 1, signal: e.signal ?? null, timedOut: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "", pid: null, startedAt };
      }
    },
  };

  async function warmRemoteRun() {
    const executionTarget = { kind: "remote" as const, transport: "sandbox" as const, environmentId: randomUUID(), leaseId: randomUUID(), remoteCwd, runner };
    await db.insert(environments).values({ id: executionTarget.environmentId, name: `Checkpoint fixture ${executionTarget.environmentId}`, driver: "sandbox" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    await db.insert(environmentLeases).values({ id: executionTarget.leaseId, companyId, environmentId: executionTarget.environmentId,
      heartbeatRunId: runId, provider: "daytona", providerLeaseId: "checkpoint-fixture-allocation" });
    const copies = agentInstructionWorkingCopyService(db);
    const copy = (await copies.prepare({ companyId, agentId, runId, cwd: home, target: executionTarget, warm: true }))!;
    return { copies, copy, executionTarget };
  }

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-directory-remote-checkpoint-");
    db = createDb(database.connectionString);
    observer = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await observer?.$client.end({ timeout: 1 });
    if (db) { await closeFileStorageDb(db, 1); await db.$client.end({ timeout: 1 }); }
    await database?.cleanup();
  });
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-directory-remote-checkpoint-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    runnerDelay.ms = 0; calls.length = 0; gate = null;
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    root = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "Owner", adapterConfig: {} });
    remoteCwd = path.join(home, "remote-task");
    await fs.mkdir(remoteCwd, { recursive: true });
    await db.insert(companies).values({ id: companyId, name: "Remote checkpoint locking", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner",
      adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId,
      permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, entryFile), "# Policy\n");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("captures a turn's remote files without holding the directory lock and its database connection", async () => {
    const { copies, copy, executionTarget } = await warmRemoteRun();
    await fs.writeFile(path.join(copy.executionRoot, "memory.txt"), "turn one\n");
    runnerDelay.ms = 200;
    calls.length = 0;
    const startedAt = performance.now();
    let lockedMs = 0;
    let sampling = true;
    const sampler = (async () => {
      let last = performance.now();
      while (sampling) {
        const held = await directoryLockHeld();
        const now = performance.now();
        if (held) lockedMs += now - last;
        last = now;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })();
    let saved: Awaited<ReturnType<typeof copies.checkpointWarm>>;
    let elapsedMs: number;
    try {
      saved = await copies.checkpointWarm({ companyId, runId: copy.runId, target: executionTarget });
      elapsedMs = performance.now() - startedAt;
    } finally {
      sampling = false;
      await sampler;
    }
    expect(saved, JSON.stringify({ code: saved?.errorCode, message: saved?.errorMessage })).toMatchObject({ state: "warm_saved", errorCode: null });
    expect(await fs.readFile(path.join(root, "memory.txt"), "utf8")).toBe("turn one\n");
    console.info(JSON.stringify({ metric: "remote_checkpoint_directory_lock", runnerCalls: calls.length,
      runnerCallsWhileLocked: calls.filter(call => call.directoryLockHeld).length, lockedMs: Math.round(lockedMs), elapsedMs: Math.round(elapsedMs) }));
    expect(calls.filter(call => call.checkpointScript)).toHaveLength(1);
    expect(calls.filter(call => call.directoryLockHeld)).toEqual([]);
    expect(lockedMs).toBeLessThan(elapsedMs / 2);
  });

  it("discards an early capture when a competing collector changes the copy, and keeps the collector's outcome", async () => {
    const { copies, copy, executionTarget } = await warmRemoteRun();
    await fs.writeFile(path.join(copy.executionRoot, "memory.txt"), "final turn\n");
    let open!: () => void, reached!: () => void;
    const opened = new Promise<void>(resolve => { open = resolve; });
    const reachedPromise = new Promise<void>(resolve => { reached = resolve; });
    gate = { opened, reached, reachedPromise };
    const checkpoint = copies.checkpointWarm({ companyId, runId: copy.runId, target: executionTarget });
    await reachedPromise;
    try {
      const competitor = agentInstructionWorkingCopyService(db);
      const collected = await competitor.collectStopped({ companyId, runId: copy.runId, target: executionTarget });
      expect(collected).toMatchObject({ state: "saved", errorCode: null });
    } finally { open(); }
    const result = await checkpoint;
    const final = await copies.get(companyId, copy.runId);
    expect(result).toEqual(final);
    expect(final).toMatchObject({ state: "saved", errorCode: null, receipt: { cleanupPending: false } });
    expect(await fs.readFile(path.join(root, "memory.txt"), "utf8")).toBe("final turn\n");
    await expect(fs.stat(copy.executionRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(path.dirname(copy.localRoot)).catch(() => [])).filter(name => name.startsWith("checkpoint-"))).toEqual([]);
  });
});
