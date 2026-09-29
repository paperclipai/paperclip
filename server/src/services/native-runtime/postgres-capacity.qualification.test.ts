import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, applyPendingMigrations, closeRegisteredClients, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { PostgresAuthorityStore } from "./postgres-authority-store.js";

const execute = promisify(execFile);

// This lane consumes only a private container's 16 MiB tmpfs. The production
// disk, shared development database, WAL and other test containers are untouched.
it.skipIf(process.env.PAPERCLIP_HISTORY_PG_CAPACITY_QUALIFICATION !== "1")("retains exact authority and retries after physical PostgreSQL tablespace exhaustion", async () => {
  const ownerId = randomUUID(), name = `paperclip-history-capacity-${ownerId}`;
  const env = { ...process.env, POSTGRES_PASSWORD: randomBytes(32).toString("hex") };
  const docker = async (args: string[]) => (await execute("docker", args, { env, maxBuffer: 128 * 1024, timeout: 30_000 })).stdout.trim();
  const image = await docker(["image", "inspect", "postgres:17", "--format", "{{.Id}}"]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("capacity qualification requires an installed immutable image ID");
  let created = false, connectionString: string | undefined, root: string | undefined;
  let core: DurablePrpControlPlane | undefined;
  let evidence: Record<string, unknown> | undefined;
  const started = Date.now();
  try {
    created = true;
    await docker(["create", "--name", name, "--label", `paperclip.history-qualification=${ownerId}`,
      "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql/data:rw,size=1g",
      "--tmpfs", "/history-capacity:rw,size=16m", "--env", "POSTGRES_PASSWORD", image]);
    await docker(["start", name]);
    const inspected = JSON.parse(await docker(["inspect", name]))[0];
    const port = inspected.NetworkSettings.Ports["5432/tcp"]?.[0];
    if (inspected.Config.Labels["paperclip.history-qualification"] !== ownerId || port?.HostIp !== "127.0.0.1" || !/^[0-9]+$/.test(port.HostPort)) throw new Error("capacity fixture ownership or port mismatch");
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (await docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).then(() => true, () => false)) break;
      if (Date.now() >= deadline) throw new Error("capacity fixture readiness timeout");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    connectionString = `postgres://postgres:${env.POSTGRES_PASSWORD}@127.0.0.1:${port.HostPort}/postgres`;
    await applyPendingMigrations(connectionString);
    const db = createDb(connectionString);
    await docker(["exec", name, "mkdir", "/history-capacity/tablespace"]);
    await docker(["exec", name, "chown", "postgres:postgres", "/history-capacity/tablespace"]);
    await db.execute(sql`create tablespace history_capacity location '/history-capacity/tablespace'`);
    await db.execute(sql`alter table native_authority_records set tablespace history_capacity`);
    await db.execute(sql`create table capacity_probe (payload text not null) tablespace history_capacity`);
    await db.execute(sql`alter table capacity_probe alter column payload set storage external`);
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    const normalizedSessionId = randomUUID(), runnerInstanceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Physical capacity qualification", issuePrefix: "CAP" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Capacity fixture", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Capacity fixture", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: normalizedSessionId, runnerInstanceId, lastOutputSeq: 2_147_483_647 });
    const [outputProgress] = await db.update(heartbeatRuns).set({ lastOutputSeq: sql`${heartbeatRuns.lastOutputSeq} + 1` })
      .where(eq(heartbeatRuns.id, runId)).returning({ seq: heartbeatRuns.lastOutputSeq });
    expect(outputProgress?.seq).toBe(2_147_483_648);
    const binding = { companyId, issueId, normalizedSessionId, runnerInstanceId, runId, environmentLeaseId: "capacity-fixture" };
    const authority = new PostgresAuthorityStore(db, binding, async () => {});
    const gen1 = await authority.commit({ expectedGeneration: "0", state: { cursor: 0 }, records: [] });
    // The first insert must extend the real receipt/TOAST relation after the
    // current-state update. No SQL exception, mocked driver or error hook is used.
    const record = { epoch: runId, kind: "event" as const, id: "capacity-event", sequence: "1",
      body: { bytes: randomBytes(7 * 1024).toString("hex") } };
    const next = { expectedGeneration: gen1, state: { cursor: 1 }, records: [record] };
    const exhaust = async () => {
      const result = await execute("docker", ["exec", name, "dd", "if=/dev/zero", "of=/history-capacity/ballast", "bs=1048576", "count=32"], { env, timeout: 30_000, maxBuffer: 4096 }).then(() => null, error => error as { code?: number; stderr?: string });
      expect(result?.code).toBe(1);
      expect(result?.stderr).toContain("No space left on device");
    };
    const release = () => docker(["exec", name, "rm", "/history-capacity/ballast"]);
    await exhaust();
    await expect(authority.commit(next)).rejects.toMatchObject({ code: "storage_pressure" });
    expect(await authority.load()).toEqual({ generation: gen1, committedFrom: "0", state: { cursor: 0 } });
    expect(await authority.getRecord(runId, "event", record.id)).toBeNull();
    await release();
    const gen2 = await authority.commit(next);
    expect(await authority.load()).toEqual({ generation: gen2, committedFrom: gen1, state: { cursor: 1 } });
    expect(await authority.getRecord(runId, "event", record.id)).toEqual(record);

    // Exercise the actual in-memory control-plane rollback and same-owner
    // retry too. Its write fence performs a real allocation in that tablespace;
    // the preceding case covers rollback after authority rows have changed.
    const controllerBinding = { ...binding, normalizedSessionId: randomUUID(), runId: randomUUID() };
    await db.insert(heartbeatRuns).values({ id: controllerBinding.runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: controllerBinding.normalizedSessionId, runnerInstanceId });
    let allocate = false;
    const controllerAuthority = new PostgresAuthorityStore(db, controllerBinding, async () => {}, async tx => {
      if (allocate) await tx.execute(sql`insert into capacity_probe(payload) values (${randomBytes(128 * 1024).toString("hex")})`);
    });
    root = await mkdtemp(join(tmpdir(), "paperclip-history-pg-capacity-"));
    core = await DurablePrpControlPlane.open({ stateDirectory: root, authorityStore: controllerAuthority,
      identity: { runId: controllerBinding.runId, normalizedSessionId: controllerBinding.normalizedSessionId,
        runnerInstanceId, environmentLeaseId: binding.environmentLeaseId, turnId: "turn-1", itemId: "item-1" },
      expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    const before = await controllerAuthority.load();
    allocate = true;
    await exhaust();
    await expect(core.issueBootstrapTicket()).rejects.toMatchObject({ code: "storage_pressure" });
    expect(await controllerAuthority.load()).toEqual(before);
    expect(Object.keys(core.store.state.tickets)).toHaveLength(0);
    await release();
    expect(await core.issueBootstrapTicket()).toBeTruthy();
    expect(Object.keys(core.store.state.tickets)).toHaveLength(1);
    const after = (await controllerAuthority.load())!;
    expect(after.committedFrom).toBe(before!.generation);
    expect(after.generation).not.toBe(before!.generation);
    expect(after.generation).toMatch(/^r:/);
    const logs = await execute("docker", ["logs", name], { env, timeout: 30_000, maxBuffer: 128 * 1024 });
    expect(logs.stdout + logs.stderr).toContain("No space left on device");
    evidence = { image, backend: "PostgreSQL 17 in an isolated local Docker container", capacityBytes: 16 * 1024 * 1024,
      fault: "physical tmpfs ENOSPC, PostgreSQL relation extension", rollbackAfterAuthorityWrite: true,
      rejectedReceiptAbsent: true, exactReceiptRetried: true, sameControllerRetried: true, ticketCountAfterRetry: 1,
      outputProgressBeyondSigned32Bit: outputProgress!.seq };
  } finally {
    try {
      await core?.stop();
    } finally {
      if (connectionString) await closeRegisteredClients(connectionString);
      if (root) await rm(root, { recursive: true, force: true });
      if (created) {
        const found = await docker(["inspect", name]).then(value => JSON.parse(value)[0], () => null);
        if (found) {
          if (found.Config.Labels["paperclip.history-qualification"] !== ownerId) throw new Error("capacity fixture cleanup owner mismatch");
          await docker(["rm", "--force", "--volumes", found.Id]);
        }
      }
    }
  }
  if (process.env.PAPERCLIP_HISTORY_REPORT) await writeFile(process.env.PAPERCLIP_HISTORY_REPORT,
    JSON.stringify({ ...evidence, status: "passed", cleanupVerified: true, elapsedMs: Date.now() - started }, null, 2), { mode: 0o600 });
}, 180_000);
