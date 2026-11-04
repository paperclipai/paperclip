import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
});
