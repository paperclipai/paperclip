import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { NativeSession } from "../../vendor/paperclip-runner/index.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { canonicalProviderPackJson, type ProviderPackIdentity } from "./remote-provider-pack-verification.js";
import { admittedNativeProviderPack, NativeProviderPackAdmissionConflictError, recordNativeProviderPackAdmission,
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
function receiptDb(receipt: unknown): Db {
  return { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ receipt }] }) }) }) } as unknown as Db;
}

describe("provider pack admission identity", () => {
  it("does not publish selected configuration before successful session admission", async () => {
    const { session } = sessionFixture();
    const db = new Proxy({}, { get: () => { throw new Error("unexpected database access"); } }) as Db;
    expect(admittedNativeProviderPack(session, initial)).toBeNull();
    await expect(recordNativeProviderPackAdmission(db, { session, identity: initial,
      claim: { leaseOwner: "owner", attempt: 1, controllerGeneration: 1, controllerBootId: "boot" } })).resolves.toBe(false);
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
      "runnerInstanceId", "environmentLeaseId", "providerPackDigest", "opencodeProxySha256", "sourceRevision", "inheritedFromRunId"].sort());
    expect(remember(session, target, original)).toBe(true);
    expect(admittedNativeProviderPack(session, target)).toEqual(next);
    expect(() => remember(session, target, manifest("b".repeat(40)))).toThrow(NativeProviderPackAdmissionConflictError);
    expect(admittedNativeProviderPack(session, target)).toEqual(next);
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
  it.each(["companyId", "agentId", "runId", "sessionId", "runnerInstanceId", "environmentLeaseId"] as const)("rejects a prior receipt with a different %s", async key => {
    const source = sessionFixture(); remember(source.session);
    const saved = { ...admittedNativeProviderPack(source.session, initial)!, [key]: "foreign" };
    const recovered = sessionFixture();
    await expect(rememberRecoveredNativeProviderPack(receiptDb(saved), recovered.session,
      { identity: initial, sourceRunId: initial.runId, ...binding })).resolves.toBe(false);
    expect(admittedNativeProviderPack(recovered.session, initial)).toBeNull();
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
    const profile = { preserved: { value: "unchanged" }, nativeExecutionInput: { binding: identity } };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "running", runnerProfileJson: profile });
    const claim = { leaseOwner: randomUUID(), attempt: 1, controllerGeneration: 2, controllerBootId: randomUUID() };
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", ...claim,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    const { session } = sessionFixture(identity); remember(session, identity);
    return { identity, session, claim, profile };
  }
  const read = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
  it("merges the exact closed receipt without changing other profile data and is idempotent", async () => {
    const f = await fixture();
    await expect(recordNativeProviderPackAdmission(db, f)).resolves.toBe(true);
    const saved = await read(f.identity.runId);
    expect(saved.runnerProfileJson).toEqual({ ...f.profile, nativeProviderPackAdmission: admittedNativeProviderPack(f.session, f.identity) });
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
    const before = (await read(f.identity.runId)).runnerProfileJson;
    const other = sessionFixture(f.identity); remember(other.session, f.identity, manifest("b".repeat(40)));
    await expect(recordNativeProviderPackAdmission(db, { ...f, session: other.session })).rejects.toBeInstanceOf(NativeProviderPackAdmissionConflictError);
    expect((await read(f.identity.runId)).runnerProfileJson).toEqual(before);
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
    expect((await read(f.identity.runId)).runnerProfileJson).toEqual(original);
  });
  it("cannot publish while another transaction holds the coordinator claim", async () => {
    const f = await fixture();
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
      expect((await read(f.identity.runId)).runnerProfileJson).toEqual(f.profile);
    } finally { release(); await owner; }
    await expect(recordNativeProviderPackAdmission(db, f)).resolves.toBe(true);
  });
});
