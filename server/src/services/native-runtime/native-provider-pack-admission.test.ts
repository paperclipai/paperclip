import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { NativeSession } from "../../vendor/paperclip-runner/index.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { canonicalProviderPackJson, type ProviderPackIdentity } from "./remote-provider-pack-verification.js";
import { admittedNativeProviderPack, nativeProviderPackAdmissionPending, recordNativeProviderPackAdmission,
  rememberAdmittedNativeProviderPack, rememberRecoveredNativeProviderPack } from "./native-provider-pack-admission.js";

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function manifest(revision = "a".repeat(40)): ProviderPackIdentity {
  const artifact = { path: "/private/provider-path", sha256: hash(revision) };
  const payload = { runnerSourceRevision: revision, pins: { opencode: "1.18.34" },
    target: { platform: "linux", architecture: "x64" },
    artifacts: { nodeCommand: artifact, opencodeCommand: artifact, opencodeProxy: artifact } };
  return { schema: "paperclip-runner/remote-provider-pack/v1", payload, digest: hash(canonicalProviderPackJson(payload)) };
}
const initial = { companyId: "company", agentId: "agent", issueId: "issue", runId: "source-run", sessionId: "session" };
function sessionFixture(identity = initial) {
  let current = { ...identity };
  const session = { identity: () => ({ ...current }), attachRun: async ({ identity: next }: { identity: typeof initial }) => { current = { ...next }; } } as NativeSession;
  return { session, attach: (next: typeof initial) => session.attachRun!({ identity: next }) };
}
const binding = { runnerInstanceId: "runner", environmentLeaseId: "lease" };
function remember(session: NativeSession, identity = initial, selected = manifest()) {
  return rememberAdmittedNativeProviderPack(session, { identity, ...binding, manifest: selected });
}
const verified = { ...nativeProviderPackAdmissionPending(randomUUID()), state: "verified" };
function receiptDb(receipt: unknown, state: unknown = verified): Db {
  return { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ receipt, state }] }) }) }) } as unknown as Db;
}

describe("provider pack admission identity", () => {
  it("does not publish selected configuration before successful session admission", async () => {
    const { session } = sessionFixture();
    expect(admittedNativeProviderPack(session, initial)).toBeNull();
  });
  it("keeps a closed original pack identity through an actual target attachment", async () => {
    const { session, attach } = sessionFixture();
    const original = manifest();
    expect(remember(session, initial, original)).toBe(true);
    const before = admittedNativeProviderPack(session, initial)!;
    const target = { ...initial, runId: "target-run", issueId: "target-issue" };
    expect(admittedNativeProviderPack(session, target)).toBeNull();
    await attach(target);
    const next = admittedNativeProviderPack(session, target)!;
    expect(next).toEqual({ ...before, runId: target.runId, inheritedFromRunId: initial.runId });
    expect(JSON.stringify(next)).not.toContain("private/provider-path");
    expect(Object.keys(next).sort()).toEqual(["schema", "stage", "authority", "companyId", "agentId", "runId", "sessionId",
      "runnerInstanceId", "runnerEnvironmentLeaseId", "providerPackDigest", "opencodeProxySha256", "sourceRevision", "inheritedFromRunId"].sort());
    expect(remember(session, target, original)).toBe(true);
    expect(admittedNativeProviderPack(session, target)).toEqual(next);
    expect(remember(session, target, manifest("b".repeat(40)))).toBe(true);
    expect(admittedNativeProviderPack(session, target)).toMatchObject({ sourceRevision: "b".repeat(40), runId: target.runId });
  });
  it.each(["companyId", "agentId", "issueId", "runId", "sessionId"] as const)("rejects a returned session with a different %s", key => {
    const { session } = sessionFixture();
    expect(remember(session, { ...initial, [key]: "foreign" })).toBe(false);
    expect(admittedNativeProviderPack(session, initial)).toBeNull();
  });
  it("rejects stale manifest digests and unavailable source identity", () => {
    const { session } = sessionFixture();
    const stale = manifest(); stale.payload.artifacts.opencodeProxy.sha256 = hash("changed");
    expect(remember(session, initial, stale)).toBe(false);
    expect(remember(session, initial, manifest("unknown"))).toBe(false);
    expect(admittedNativeProviderPack(session, initial)).toBeNull();
  });
  it("does not reuse an earlier in-memory proof for an unsupported new admission", async () => {
    const { session } = sessionFixture(); remember(session);
    expect(remember(session, initial, manifest("unknown"))).toBe(false);
    expect(admittedNativeProviderPack(session, initial)).toBeNull();
    remember(session);
    await expect(rememberRecoveredNativeProviderPack(receiptDb(undefined), session,
      { identity: initial, sourceRunId: initial.runId, ...binding })).resolves.toBe(false);
    expect(admittedNativeProviderPack(session, initial)).toBeNull();
  });
  it("restores only the exact prior closed Core receipt and leaves legacy absence unknown", async () => {
    const source = sessionFixture(); remember(source.session);
    const saved = admittedNativeProviderPack(source.session, initial)!;
    const recovered = sessionFixture();
    await expect(rememberRecoveredNativeProviderPack(receiptDb(undefined), recovered.session,
      { identity: initial, sourceRunId: initial.runId, ...binding })).resolves.toBe(false);
    expect(admittedNativeProviderPack(recovered.session, initial)).toBeNull();
    await expect(rememberRecoveredNativeProviderPack(receiptDb(saved), recovered.session,
      { identity: initial, sourceRunId: initial.runId, ...binding })).resolves.toBe(true);
    const target = { ...initial, runId: "target-run" };
    expect(admittedNativeProviderPack(recovered.session, target)).toBeNull();
    await recovered.attach(target);
    expect(admittedNativeProviderPack(recovered.session, target)).toEqual({ ...saved, runId: target.runId, inheritedFromRunId: initial.runId });
  });
  it.each(["companyId", "agentId", "runId", "sessionId", "runnerInstanceId", "runnerEnvironmentLeaseId"] as const)("rejects a prior receipt with a different %s", async key => {
    const source = sessionFixture(); remember(source.session);
    const saved = { ...admittedNativeProviderPack(source.session, initial)!, [key]: "foreign" };
    const recovered = sessionFixture();
    await expect(rememberRecoveredNativeProviderPack(receiptDb(saved), recovered.session,
      { identity: initial, sourceRunId: initial.runId, ...binding })).resolves.toBe(false);
    expect(admittedNativeProviderPack(recovered.session, initial)).toBeNull();
  });
  it.each([undefined, { ...verified, state: "pending" }, { ...verified, state: "unknown" }])("does not revive a historical receipt without verified current provenance: %j", async state => {
    const source = sessionFixture(); remember(source.session);
    const recovered = sessionFixture();
    const absentState = state === undefined ? null : state;
    await expect(rememberRecoveredNativeProviderPack(receiptDb(admittedNativeProviderPack(source.session, initial), absentState), recovered.session,
      { identity: initial, sourceRunId: initial.runId, ...binding })).resolves.toBe(false);
    expect(admittedNativeProviderPack(recovered.session, initial)).toBeNull();
  });
  it("uses only the exact same-run locked pre-invalidation source snapshot", async () => {
    const source = sessionFixture(); remember(source.session);
    const saved = admittedNativeProviderPack(source.session, initial)!;
    const recovered = sessionFixture();
    const db = receiptDb(saved, nativeProviderPackAdmissionPending(randomUUID()));
    await expect(rememberRecoveredNativeProviderPack(db, recovered.session,
      { identity: initial, sourceRunId: initial.runId, ...binding, source: { runId: "foreign-run", receipt: saved, state: verified } })).resolves.toBe(false);
    await expect(rememberRecoveredNativeProviderPack(db, recovered.session,
      { identity: initial, sourceRunId: initial.runId, ...binding, source: { runId: initial.runId, receipt: saved, state: verified } })).resolves.toBe(true);
  });
});

describe("provider pack admission PostgreSQL fencing", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("pack-admission-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pack admission", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pack agent" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Pack task", assigneeAgentId: agentId });
    const identity = { companyId, agentId, issueId, runId, sessionId: `session-${runId}` };
    const admissionEpoch = randomUUID();
    const profile = { preserved: { value: "unchanged" }, nativeExecutionInput: { binding: identity },
      nativeProviderPackAdmissionState: nativeProviderPackAdmissionPending(admissionEpoch) };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "running", runnerProfileJson: profile });
    const claim = { leaseOwner: randomUUID(), attempt: 1, controllerGeneration: 2, controllerBootId: randomUUID() };
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", ...claim,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    const { session } = sessionFixture(identity); remember(session, identity);
    return { identity, session, claim, profile, admissionEpoch };
  }
  const read = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
  it("merges the exact closed receipt without changing other profile data and is idempotent", async () => {
    const f = await fixture();
    await expect(recordNativeProviderPackAdmission(db, f)).resolves.toBe(true);
    const saved = await read(f.identity.runId);
    expect(saved.runnerProfileJson).toEqual({ ...f.profile, nativeProviderPackAdmission: admittedNativeProviderPack(f.session, f.identity),
      nativeProviderPackAdmissionState: { ...f.profile.nativeProviderPackAdmissionState, state: "verified" } });
    await expect(recordNativeProviderPackAdmission(db, f)).resolves.toBe(true);
    expect((await read(f.identity.runId)).runnerProfileJson).toEqual(saved.runnerProfileJson);
  });
  it.each(["leaseOwner", "attempt", "controllerGeneration", "controllerBootId"] as const)("rejects stale %s without publishing a receipt", async key => {
    const f = await fixture();
    const changed = typeof f.claim[key] === "number" ? 99 : randomUUID();
    await expect(recordNativeProviderPackAdmission(db, { ...f, claim: { ...f.claim, [key]: changed } as typeof f.claim })).resolves.toBe(false);
    expect((await read(f.identity.runId)).runnerProfileJson).toEqual(f.profile);
  });
  it("rejects an expired claim and a terminal run", async () => {
    const f = await fixture();
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.identity.runId));
    await expect(recordNativeProviderPackAdmission(db, f)).resolves.toBe(false);
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.identity.runId));
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.identity.runId));
    await expect(recordNativeProviderPackAdmission(db, f)).resolves.toBe(false);
    expect((await read(f.identity.runId)).runnerProfileJson).toEqual(f.profile);
  });
  it("preserves the original immutable receipt when another pack is proposed", async () => {
    const f = await fixture(); await recordNativeProviderPackAdmission(db, f);
    const before = (await read(f.identity.runId)).runnerProfileJson!;
    const other = sessionFixture(f.identity); remember(other.session, f.identity, manifest("b".repeat(40)));
    await expect(recordNativeProviderPackAdmission(db, { ...f, session: other.session })).resolves.toBe(false);
    expect((await read(f.identity.runId)).runnerProfileJson).toEqual({ ...before,
      nativeProviderPackAdmissionState: { ...f.profile.nativeProviderPackAdmissionState, state: "unknown" } });
    await expect(recordNativeProviderPackAdmission(db, f)).resolves.toBe(false);
  });
  it("preserves the original inheritance when the same run recovers the same verified pack", async () => {
    const f = await fixture(), sourceRunId = randomUUID();
    const receipt = admittedNativeProviderPack(f.session, f.identity)!;
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.identity.companyId, agentId: f.identity.agentId,
      nativeIssueId: f.identity.issueId, runtimeMode: "native", status: "succeeded",
      runnerProfileJson: { nativeProviderPackAdmission: { ...receipt, runId: sourceRunId } } });
    const original = { ...f.profile, nativeProviderPackAdmission: { ...receipt, inheritedFromRunId: sourceRunId } };
    await db.update(heartbeatRuns).set({ runnerProfileJson: original }).where(eq(heartbeatRuns.id, f.identity.runId));
    await expect(recordNativeProviderPackAdmission(db, f)).resolves.toBe(true);
    expect((await read(f.identity.runId)).runnerProfileJson).toEqual({ ...original,
      nativeProviderPackAdmissionState: { ...f.profile.nativeProviderPackAdmissionState, state: "verified" } });
  });
  it("leaves a newer pending epoch untouched by an older same-claim callback", async () => {
    const f = await fixture(); await recordNativeProviderPackAdmission(db, f);
    const previous = (await read(f.identity.runId)).runnerProfileJson!;
    const next = { ...previous, nativeProviderPackAdmissionState: nativeProviderPackAdmissionPending(randomUUID()) };
    await db.update(heartbeatRuns).set({ runnerProfileJson: next }).where(eq(heartbeatRuns.id, f.identity.runId));
    await expect(recordNativeProviderPackAdmission(db, f)).resolves.toBe(false);
    expect((await read(f.identity.runId)).runnerProfileJson).toEqual(next);
  });
  it.each(["runner", "lease", "unsupported"])("keeps the first receipt historical after an authorized %s replacement", async change => {
    const f = await fixture(); await recordNativeProviderPackAdmission(db, f);
    const previous = (await read(f.identity.runId)).runnerProfileJson!;
    const admissionEpoch = randomUUID();
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...previous,
      nativeProviderPackAdmissionState: nativeProviderPackAdmissionPending(admissionEpoch) } }).where(eq(heartbeatRuns.id, f.identity.runId));
    const replacement = sessionFixture(f.identity);
    if (change !== "unsupported") rememberAdmittedNativeProviderPack(replacement.session, { identity: f.identity, manifest: manifest(),
      ...binding, ...(change === "runner" ? { runnerInstanceId: "replacement" } : { environmentLeaseId: "replacement" }) });
    await expect(recordNativeProviderPackAdmission(db, { ...f, admissionEpoch, session: replacement.session })).resolves.toBe(false);
    expect((await read(f.identity.runId)).runnerProfileJson).toEqual({ ...previous,
      nativeProviderPackAdmissionState: { ...nativeProviderPackAdmissionPending(admissionEpoch), state: "unknown" } });
  });
  it("cannot publish while another transaction holds the coordinator claim", async () => {
    const f = await fixture();
    await recordNativeProviderPackAdmission(db, f);
    const previous = (await read(f.identity.runId)).runnerProfileJson!;
    f.admissionEpoch = randomUUID();
    const pending = { ...previous, nativeProviderPackAdmissionState: nativeProviderPackAdmissionPending(f.admissionEpoch) };
    await db.update(heartbeatRuns).set({ runnerProfileJson: pending }).where(eq(heartbeatRuns.id, f.identity.runId));
    let release!: () => void, locked!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const owner = db.transaction(async tx => {
      await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.identity.runId)).for("update");
      locked(); await hold;
    });
    try {
      await acquired;
      await expect(recordNativeProviderPackAdmission(db, f)).rejects.toThrow();
      expect((await read(f.identity.runId)).runnerProfileJson).toEqual(pending);
    } finally { release(); await owner; }
    await expect(recordNativeProviderPackAdmission(db, f)).resolves.toBe(true);
  });
  it.each([false, true])("waits for a concurrent run-event append's run-row lock instead of losing the admission (waitForClaim: %s)", async waitForClaim => {
    // Staging failure: a run-event append locks the run row
    // (FOR NO KEY UPDATE, as appendHeartbeatRunEvent does) for milliseconds. A
    // NOWAIT admission write failed, left the state pending, and artifact
    // retention then failed the run as native_provider_artifacts_admission_unverified.
    const f = await fixture();
    let release!: () => void, acquired!: () => void;
    const holding = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const append = db.transaction(async tx => {
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, f.identity.runId)).for("no key update");
      acquired(); await gate;
    });
    await holding;
    let settled = false;
    const recording = recordNativeProviderPackAdmission(db, { ...f, waitForClaim } as Parameters<typeof recordNativeProviderPackAdmission>[1])
      .then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    try {
      // Release only after the admission is proven to wait on the run row, so
      // the old NOWAIT code cannot pass by running after the append commits.
      await vi.waitFor(async () => {
        const [row] = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and state = 'active'
            and query like '%heartbeat_runs%') as waiting`);
        expect(settled || row.waiting).toBe(true);
      }, { timeout: 800 });
    } finally { release(); await append; }
    expect(await recording).toEqual({ value: true });
    expect((await read(f.identity.runId)).runnerProfileJson?.nativeProviderPackAdmissionState)
      .toEqual({ ...f.profile.nativeProviderPackAdmissionState, state: "verified" });
  });
  it("keeps the admission when a checkpoint write holds the claim longer than one lock wait", async () => {
    // Staging run 3f317172 (OpenCode, fresh Daytona sandbox): the pack upload
    // and runner start succeeded, the runner began writing durable checkpoints,
    // and the admission write lost one 1000 ms lock wait on the coordinator row
    // a checkpoint transaction held. The state stayed pending, artifact
    // retention failed the run as native_provider_artifacts_admission_unverified
    // and the task rested blocked before its first turn.
    const f = await fixture();
    let release!: () => void, acquired!: () => void;
    const holding = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const checkpoint = db.transaction(async tx => {
      await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.identity.runId)).for("update");
      acquired(); await gate;
    });
    await holding;
    const recording = recordNativeProviderPackAdmission(db, { ...f, waitForClaim: true } as Parameters<typeof recordNativeProviderPackAdmission>[1])
      .then(value => ({ value }), error => ({ error }));
    // Longer than one lock wait, shorter than the bounded retry window.
    const held = setTimeout(release, 1_600);
    try {
      expect(await recording).toEqual({ value: true });
    } finally { clearTimeout(held); release(); await checkpoint; }
    expect((await read(f.identity.runId)).runnerProfileJson?.nativeProviderPackAdmissionState)
      .toEqual({ ...f.profile.nativeProviderPackAdmissionState, state: "verified" });
  });
  it("gives up after the bounded retry window while the claim stays held", async () => {
    const f = await fixture();
    let release!: () => void, acquired!: () => void;
    const holding = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const checkpoint = db.transaction(async tx => {
      await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.identity.runId)).for("update");
      acquired(); await gate;
    });
    await holding;
    const started = Date.now();
    try {
      await expect(recordNativeProviderPackAdmission(db, { ...f, waitForClaim: true } as Parameters<typeof recordNativeProviderPackAdmission>[1]))
        .rejects.toMatchObject({ cause: { code: "55P03" } });
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally { release(); await checkpoint; }
    expect((await read(f.identity.runId)).runnerProfileJson).toEqual(f.profile);
  }, 30_000);
  it.each([false, true])("waits within the durable-capture bound and rechecks the claim after its lock (revoked: %s)", async revoked => {
    const f = await fixture();
    let release!: () => void, acquired!: () => void;
    const holding = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const owner = db.transaction(async tx => {
      await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.identity.runId)).for("update");
      acquired(); await gate;
      if (revoked) await tx.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(nativeRunFinalizations.runId, f.identity.runId));
    });
    let settled = false;
    await holding;
    const recording = recordNativeProviderPackAdmission(db, { ...f, waitForClaim: true } as Parameters<typeof recordNativeProviderPackAdmission>[1])
      .then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    try {
      await vi.waitFor(async () => {
        const [row] = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and state = 'active'
            and query like '%native_run_finalizations%') as waiting`);
        expect(settled || row.waiting).toBe(true);
      }, { timeout: 800 });
      expect(settled).toBe(false);
    } finally { release(); await owner; }
    if (revoked) {
      expect(await recording).toHaveProperty("error");
      expect((await read(f.identity.runId)).runnerProfileJson?.nativeProviderPackAdmissionState).toEqual(f.profile.nativeProviderPackAdmissionState);
    } else expect(await recording).toEqual({ value: true });
  });
});
