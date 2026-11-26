import crypto, { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, agentTaskSessions, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues,
  nativeRunFinalizations, nativeRunnerCheckpoints, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createLocalEncryptedCipher } from "../../secrets/local-encrypted-provider.js";
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { createNativeRunnerUpgradeHeaderMemo, directNativeRunnerUpgradeHeaderRead } from "../native-runtime/native-runner-checkpoint.js";
import { readNativeControllerRecoveryInventory } from "../native-runtime/native-controller-recovery-inventory.js";
import { currentNativeControllerIdentity } from "../native-runtime/native-restart-recovery.js";
import { readUpgradeReadiness } from "./upgrade-readiness.js";

const KEY = "a".repeat(64), OTHER_KEY = "c".repeat(64);
type Run = { runId: string; issueId: string; runnerInstanceId: string; sessionId: string; workspaceId: string };

describe("upgrade readiness header memo", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  /** `db`, counting the header material that reaches this process. */
  let observed: Db, materials = 0;
  /** Runs once, after a header query returns and before its rows are inspected: the next query, or the one after `skip`. */
  let afterQuery: { skip: number; run: () => void } | undefined;
  let template = "", companyId = "", agentId = "";
  let decryptions = 0;
  const seeded: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("upgrade-readiness-header-memo-");
    db = createDb(database.connectionString);
    observed = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return (work: (tx: unknown) => Promise<unknown>, options: unknown) => (target.transaction as (...args: unknown[]) => Promise<unknown>)(
        (tx: { execute: (...args: unknown[]) => Promise<unknown> }) => work(new Proxy(tx, { get(inner, name) {
          if (name !== "execute") return Reflect.get(inner, name);
          return async (...args: unknown[]) => {
            const rows = await inner.execute(...args);
            if (Array.isArray(rows)) materials += rows.filter(row => (row as { material?: unknown }).material).length;
            if (Array.isArray(rows) && rows.length && afterQuery && afterQuery.skip-- === 0) { afterQuery.run(); afterQuery = undefined; }
            return rows;
          };
        } })), options);
    } });
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", KEY);
    const createDecipheriv = crypto.createDecipheriv;
    vi.spyOn(crypto, "createDecipheriv").mockImplementation(((...args: Parameters<typeof createDecipheriv>) => {
      decryptions++;
      return createDecipheriv(...args);
    }) as typeof createDecipheriv);
    syncBuiltinESMExports();
    companyId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Header memo", issuePrefix: `H${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Header memo", role: "engineer", adapterType: "paperclip_runner" });
    // A header a real control plane wrote; each fixture run gets its own identity in it.
    const root = await mkdtemp(join(tmpdir(), "upgrade-header-memo-"));
    const core = new DurablePrpControlPlane({ stateDirectory: root, identity: { runId: randomUUID(), runnerInstanceId: randomUUID(),
      normalizedSessionId: randomUUID(), environmentLeaseId: randomUUID(), turnId: "turn", itemId: "item" },
      expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    core.setCheckpointPersistence(async checkpoint => { template = checkpoint.records.get("header")!; });
    try { core.issueBootstrapTicket(); await core.flushCheckpoint(); }
    finally { await core.stop(); await rm(root, { recursive: true, force: true }); }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    afterQuery = undefined;
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", undefined);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", KEY);
    if (!seeded.length) return;
    await db.delete(agentTaskSessions).where(eq(agentTaskSessions.companyId, companyId));
    await db.update(heartbeatRuns).set({ status: "failed" }).where(inArray(heartbeatRuns.id, seeded.splice(0)));
  });
  afterAll(async () => {
    vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs();
    await db?.$client.end(); await database?.cleanup();
  });

  type Header = Record<string, unknown>;
  function headerContents(run: Run, patch: (header: Header) => Header = header => header) {
    const header = JSON.parse(template) as Header & { state: Header };
    return JSON.stringify(patch({ ...header, state: { ...header.state, identity: { runId: run.runId,
      runnerInstanceId: run.runnerInstanceId, normalizedSessionId: run.sessionId, environmentLeaseId: run.workspaceId,
      turnId: "turn", itemId: "item" } } }));
  }
  function material(run: Run, contents = headerContents(run), key = KEY) {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", key);
    try {
      return createLocalEncryptedCipher("write").encrypt(JSON.stringify({ companyId, issueId: run.issueId, runId: run.runId, part: "header", contents }));
    } finally { vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", KEY); }
  }
  const setHeader = (run: Run, value: Record<string, unknown>) => db.update(nativeRunnerCheckpoints).set({ material: value })
    .where(and(eq(nativeRunnerCheckpoints.runId, run.runId), eq(nativeRunnerCheckpoints.part, "header")));
  /** Active runs this server could hand to its replacement, or finished runs a task session still selects. */
  async function seed(count: number, active = true) {
    const owner = await currentNativeControllerIdentity();
    const runs: Run[] = Array.from({ length: count }, () => ({ runId: randomUUID(), issueId: randomUUID(),
      runnerInstanceId: randomUUID(), sessionId: randomUUID(), workspaceId: randomUUID() }));
    await db.insert(issues).values(runs.map(run => ({ id: run.issueId, companyId, title: "Synthetic work", status: "todo" })));
    await db.insert(heartbeatRuns).values(runs.map(run => ({ id: run.runId, companyId, agentId, issueId: run.issueId,
      nativeIssueId: run.issueId, runtimeMode: "native", runnerInstanceId: run.runnerInstanceId, nativeSessionId: run.sessionId,
      ...(active ? { status: "running", processPid: process.pid, processStartedAt: new Date(),
        runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v1", state: "prepared",
          descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), workspaceId: run.workspaceId,
          leaseId: randomUUID(), providerLeaseId: "synthetic-sandbox", remoteCwd: "/workspace" } } }
        : { status: "succeeded", finishedAt: new Date(), runnerProfileJson: { nativeControllerRecovery: {
          schema: "paperclip.native-controller-recovery.v1",
          checkpoint: { runId: run.runId, runnerInstanceId: run.runnerInstanceId, normalizedSessionId: run.sessionId } } } }) })));
    await db.insert(nativeRunFinalizations).values(runs.map(run => ({ runId: run.runId, companyId, issueId: run.issueId,
      ...(active ? { phase: "observed", controllerBootId: owner.bootId, leaseOwner: "memo-lease", controllerGeneration: 1,
        leaseExpiresAt: new Date(Date.now() + 3_600_000) } : { phase: "committed" }) })));
    await db.insert(nativeRunnerCheckpoints).values(runs.map(run => ({ companyId, runId: run.runId, issueId: run.issueId,
      part: "header", material: material(run) })));
    if (!active) await db.insert(agentTaskSessions).values(runs.map(run => ({ companyId, agentId,
      adapterType: "paperclip_runner", taskKey: run.issueId, lastRunId: run.runId })));
    seeded.push(...runs.map(run => run.runId));
    return runs;
  }
  /** One probe, with the header material that reached this process and the decryptions it ran. */
  async function probe(runs: Run[], headers?: Parameters<typeof readUpgradeReadiness>[1]["headers"]) {
    const ids = new Set(runs.map(run => run.runId));
    const before = decryptions, read = materials;
    const report = await readUpgradeReadiness(observed, { activeRunIds: ids,
      counters: () => ({ activeRuns: ids.size, pendingWakes: 0, draining: false }), headers });
    return { materials: materials - read, decryptions: decryptions - before, report: { ...report, observedAt: null,
      nativeControllerRecovery: { ...report.nativeControllerRecovery, retained: { ...report.nativeControllerRecovery.retained, observedAt: null } } } };
  }
  /** The answer when every inspected header is read and decrypted, as before the memo. */
  const reference = async (runs: Run[]) => (await probe(runs, directNativeRunnerUpgradeHeaderRead())).report;

  it("reads and decrypts no header on a repeated probe of unchanged runs", async () => {
    const runs = await seed(4), retained = await seed(3, false);
    const first = await probe(runs);
    expect(first.report).toMatchObject({ ready: true, recoverableRuns: 4, blockingRuns: 0,
      nativeControllerRecovery: { retained: { selectedRetainedEvidence: retained.length } } });
    // Every header that contributes evidence is read and decrypted once.
    expect(first).toMatchObject({ materials: 7, decryptions: 7 });
    for (let repeat = 0; repeat < 3; repeat++) {
      const again = await probe(runs);
      expect(again.report).toEqual(first.report);
      expect({ materials: again.materials, decryptions: again.decryptions }).toEqual({ materials: 0, decryptions: 0 });
    }
    expect(await reference(runs)).toEqual(first.report);
  });

  it("re-inspects a checkpoint that changes between two probes", async () => {
    const runs = await seed(3), [changed] = runs;
    expect((await probe(runs)).report).toMatchObject({ ready: true, recoverableRuns: 3 });
    expect((await probe(runs)).materials).toBe(0);
    // The run's checkpoint now belongs to another workspace. Only the material changes: no updated_at.
    await setHeader(changed, material(changed, headerContents({ ...changed, workspaceId: randomUUID() })));
    const after = await probe(runs);
    expect(after.report).toMatchObject({ ready: false, recoverableRuns: 2, blockingRuns: 1 });
    expect(after).toMatchObject({ materials: 1, decryptions: 1 });
    expect(after.report).toEqual(await reference(runs));
    // Unchanged again: the new answer is the one remembered, also after the rows are frozen or moved.
    expect(await probe(runs)).toMatchObject({ materials: 0, report: { ready: false, recoverableRuns: 2 } });
    await db.execute(sql`vacuum (freeze) native_runner_checkpoints`);
    expect(await probe(runs)).toMatchObject({ materials: 0, report: { ready: false, recoverableRuns: 2 } });
    await db.execute(sql`vacuum (full) native_runner_checkpoints`);
    expect((await probe(runs)).report).toEqual(await reference(runs));
    // The same content written again is a new revision, so it is inspected again.
    await setHeader(changed, material(changed));
    expect(await probe(runs)).toMatchObject({ materials: 1, decryptions: 1, report: { ready: true, recoverableRuns: 3 } });
    await db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, changed.runId));
    await db.insert(nativeRunnerCheckpoints).values({ companyId, runId: changed.runId, issueId: changed.issueId, part: "header",
      material: material(changed, headerContents({ ...changed, sessionId: randomUUID() })) });
    expect(await probe(runs)).toMatchObject({ materials: 1, report: { ready: false, recoverableRuns: 2 } });
  });

  it("gives the answer of reading every header in every state, warm or cold", async () => {
    const runs = await seed(4), retained = await seed(2, false), [target] = runs;
    const legacy = (header: Header) => ({ ...header, schema: "paperclip.runner.controller-checkpoint.v1" });
    const states: Array<[string, () => Promise<unknown>, { ready: boolean; recoverableRuns: number }]> = [
      ["every header binds its run", async () => {}, { ready: true, recoverableRuns: 4 }],
      ["a header names another runner", () => setHeader(target, material(target, headerContents({ ...target, runnerInstanceId: randomUUID() }))), { ready: false, recoverableRuns: 3 }],
      ["a header is encrypted under another key", () => setHeader(target, material(target, headerContents(target), OTHER_KEY)), { ready: false, recoverableRuns: 3 }],
      ["a header is bound to another run", () => setHeader(target, material({ ...target, runId: randomUUID() })), { ready: false, recoverableRuns: 3 }],
      ["a header is not encrypted material", () => setHeader(target, {}), { ready: false, recoverableRuns: 3 }],
      ["a header's ciphertext is damaged", async () => {
        const good = material(target) as Record<string, string>;
        await setHeader(target, { ...good, ciphertext: Buffer.from("damaged").toString("base64") + good.ciphertext.slice(12) });
      }, { ready: false, recoverableRuns: 3 }],
      ["a header is not valid JSON", () => setHeader(target, material(target, "{")), { ready: false, recoverableRuns: 3 }],
      ["a header has the earlier schema", () => setHeader(target, material(target, headerContents(target, legacy))), { ready: false, recoverableRuns: 3 }],
      ["a header exceeds the inspection bound", () => setHeader(target, material(target, headerContents(target, header => ({ ...header, padding: "x".repeat(1_100_000) })))), { ready: false, recoverableRuns: 3 }],
      ["a header is missing", () => db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, target.runId)), { ready: false, recoverableRuns: 3 }],
      ["the header is written again", () => db.insert(nativeRunnerCheckpoints).values({ companyId, runId: target.runId, issueId: target.issueId, part: "header", material: material(target) }), { ready: true, recoverableRuns: 4 }],
      ["a retained header names another session", () => setHeader(retained[0], material(retained[0], headerContents({ ...retained[0], sessionId: randomUUID() }))), { ready: true, recoverableRuns: 4 }],
      ["the secrets key is replaced", async () => { vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", OTHER_KEY); }, { ready: false, recoverableRuns: 0 }],
      ["the secrets key is invalid", async () => { vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "not-a-key"); }, { ready: false, recoverableRuns: 0 }],
      ["the secrets key is restored", async () => { vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", KEY); }, { ready: true, recoverableRuns: 4 }],
      ["a run ends", () => db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runs[3].runId)), { ready: false, recoverableRuns: 3 }],
    ];
    for (const [state, change, expected] of states) {
      await change();
      const answer = await reference(runs);
      expect(answer, state).toMatchObject(expected);
      // Warm from the previous state, then warm from this one.
      expect((await probe(runs)).report, state).toEqual(answer);
      expect((await probe(runs)).report, state).toEqual(answer);
      // A reader that remembers nothing yet.
      expect((await probe(runs, createNativeRunnerUpgradeHeaderMemo().read())).report, state).toEqual(answer);
    }
    expect((await reference(runs)).nativeControllerRecovery.retained).toMatchObject({ selectedRetainedEvidence: 1,
      reasons: { checkpoint_binding_missing: 1 } });
  });

  it("reads and tries a header that does not decrypt on every probe", async () => {
    const runs = await seed(2), [target] = runs;
    await setHeader(target, material(target, headerContents(target), OTHER_KEY));
    for (let repeat = 0; repeat < 3; repeat++) {
      // The other run's answer is remembered after the first probe; this one never is.
      expect(await probe(runs)).toMatchObject({ materials: repeat ? 1 : 2, decryptions: repeat ? 1 : 2,
        report: { ready: false, recoverableRuns: 1, blockingRuns: 1 } });
    }
    // It was written under the key that is now current: the next probe finds it readable.
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", OTHER_KEY);
    expect(await probe(runs)).toMatchObject({ materials: 2, decryptions: 2, report: { recoverableRuns: 1, blockingRuns: 1 } });
  });

  const replaceKey = () => { vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", OTHER_KEY); };
  const removeKey = () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(tmpdir(), `missing-secrets-key-${randomUUID()}`));
  };
  it.each([
    ["replaced", "run", replaceKey, 0], ["removed", "run", removeKey, 0],
    ["replaced", "retained session", replaceKey, 1], ["removed", "retained session", removeKey, 1],
  ] as const)("refuses a remembered header when the secrets key is %s before the %s headers are inspected", async (_change, _query, change, skip) => {
    const restore = () => {
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", undefined);
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", KEY);
    };
    const runs = await seed(3);
    await seed(2, false);
    expect((await probe(runs)).report).toMatchObject({ ready: true, recoverableRuns: 3 });
    expect((await probe(runs)).materials).toBe(0);
    // The key changes while the probe waits for its query. A direct read decrypts after that, and fails.
    afterQuery = { skip, run: change };
    const warm = await probe(runs);
    restore();
    afterQuery = { skip, run: change };
    const direct = await probe(runs, directNativeRunnerUpgradeHeaderRead());
    // Headers inspected before the change still count; those inspected after it do not.
    expect(direct).toMatchObject({ materials: 5, report: { ...(skip ? { ready: true, recoverableRuns: 3 }
      : { ready: false, recoverableRuns: 0, blockingRuns: 3 }), nativeControllerRecovery: { retained: {
      selectedRetainedEvidence: 0, reasons: { checkpoint_binding_missing: 2 } } } } });
    expect(warm.report).toEqual(direct.report);
    expect(warm.decryptions).toBe(0);
    // Nothing from that probe is remembered: with the key back, every header is read again.
    restore();
    expect(await probe(runs)).toMatchObject({ materials: 5, decryptions: 5, report: { ready: true, recoverableRuns: 3 } });
    expect(await probe(runs)).toMatchObject({ materials: 0, report: { ready: true, recoverableRuns: 3 } });

    // The same at the memo: an answer offered before the change is not served after it.
    const memo = createNativeRunnerUpgradeHeaderMemo();
    await probe(runs, memo.read());
    const read = memo.read();
    const offered = Object.entries(JSON.parse(read.known) as Record<string, string>);
    expect(offered).toHaveLength(5);
    change();
    for (const [binding, revision] of offered) {
      const [, issueId, runId] = binding.split("/");
      expect(read.inspect({ companyId, issueId, runId }, revision, null)).toBeNull();
    }
    restore();
    read.finish();
    expect(memo.size).toBe(0);
  });

  it("reads retained headers of the inventory page only, and only once", async () => {
    await seed(3, false);
    const memo = createNativeRunnerUpgradeHeaderMemo();
    const page = async (headers = memo.read()) => {
      const before = materials;
      const inventory = await readNativeControllerRecoveryInventory(observed, { limit: 2, headers });
      headers.finish();
      return { materials: materials - before, inventory: { ...inventory, observedAt: null } };
    };
    const direct = await page(directNativeRunnerUpgradeHeaderRead());
    expect(direct).toMatchObject({ materials: 2, inventory: { inspected: 2, truncated: true, selectedRetainedEvidence: 2 } });
    // The third session only shows that another page exists; its header is not inspected.
    expect(await page()).toEqual(direct);
    expect(await page()).toEqual({ ...direct, materials: 0 });
    expect(memo.size).toBe(2);
  });

  it("keeps four identifiers per header, within its bounds, and forgets a run that ended", async () => {
    const runs = await seed(5);
    const memo = createNativeRunnerUpgradeHeaderMemo();
    expect((await probe(runs, memo.read())).report).toMatchObject({ ready: true, recoverableRuns: 5 });
    expect(memo.size).toBe(5);
    expect(memo.bytes).toBeLessThan(5 * 1024);
    const read = memo.read();
    for (const [binding, revision] of Object.entries(JSON.parse(read.known) as Record<string, string>)) {
      const [, issueId, runId] = binding.split("/");
      const run = runs.find(candidate => candidate.runId === runId)!;
      expect(read.inspect({ companyId, issueId, runId }, revision, null)).toEqual({ runId, runnerInstanceId: run.runnerInstanceId,
        normalizedSessionId: run.sessionId, environmentLeaseId: run.workspaceId });
      // Without the material, only the exact revision this read offered has an answer.
      expect(read.inspect({ companyId, issueId, runId }, `${revision}0`, null)).toBeNull();
      expect(read.inspect({ companyId, issueId: randomUUID(), runId }, revision, null)).toBeNull();
    }
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(inArray(heartbeatRuns.id, runs.slice(0, 2).map(run => run.runId)));
    await probe(runs.slice(2), memo.read());
    expect(memo.size).toBe(3);
    const bounded = createNativeRunnerUpgradeHeaderMemo({ maxEntries: 2 });
    expect((await probe(runs.slice(2), bounded.read())).report).toMatchObject({ recoverableRuns: 3 });
    expect(bounded.size).toBe(2);
    // The header that was not kept is read again; the answer does not change.
    expect(await probe(runs.slice(2), bounded.read())).toMatchObject({ materials: 1, decryptions: 1, report: { recoverableRuns: 3 } });
    const tiny = createNativeRunnerUpgradeHeaderMemo({ maxBytes: 64 });
    expect((await probe(runs.slice(2), tiny.read())).report).toMatchObject({ recoverableRuns: 3 });
    expect([tiny.size, tiny.bytes]).toEqual([0, 0]);
  });
});
