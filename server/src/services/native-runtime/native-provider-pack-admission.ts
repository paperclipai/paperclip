import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { NativeSession } from "../../vendor/paperclip-runner/index.js";
import { canonicalProviderPackJson, type ProviderPackIdentity } from "./remote-provider-pack-verification.js";

type Selection = {
  admittedRunId: string;
  companyId: string;
  agentId: string;
  sessionId: string;
  runnerInstanceId: string;
  environmentLeaseId: string;
  providerPackDigest: string;
  opencodeProxySha256: string;
  sourceRevision: string;
};

export type NativeProviderPackAdmission = Omit<Selection, "admittedRunId"> & {
  schema: "paperclip.native-provider-pack-admission.v1";
  stage: "session_admitted";
  authority: "core_verified_selection";
  runId: string;
  inheritedFromRunId?: string;
};

const admitted = new WeakMap<NativeSession, Readonly<Selection>>();
const digest = /^sha256:[a-f0-9]{64}$/;
type NativeRunIdentity = ReturnType<NativeSession["identity"]>;

export class NativeProviderPackAdmissionConflictError extends Error {
  constructor() {
    super("runner_remote_provider_artifact_incompatible: provider-pack admission conflicts with the recorded Core identity");
    this.name = "NativeProviderPackAdmissionConflictError";
  }
}

function rememberSelection(session: NativeSession, selected: Selection): boolean {
  const prior = admitted.get(session);
  if (prior) {
    if (canonicalProviderPackJson(prior) !== canonicalProviderPackJson({ ...selected, admittedRunId: prior.admittedRunId })) {
      throw new NativeProviderPackAdmissionConflictError();
    }
    return true;
  }
  admitted.set(session, Object.freeze(selected));
  return true;
}

export function rememberAdmittedNativeProviderPack(session: NativeSession, input: {
  identity: NativeRunIdentity;
  runnerInstanceId: string;
  environmentLeaseId: string;
  manifest: ProviderPackIdentity;
}): boolean {
  if (typeof session.identity !== "function") return false;
  const actual = session.identity();
  if (canonicalProviderPackJson(actual) !== canonicalProviderPackJson(input.identity)) return false;
  const proxy = input.manifest.payload.artifacts.opencodeProxy?.sha256;
  const revision = input.manifest.payload.runnerSourceRevision;
  if (!digest.test(input.manifest.digest)
    || input.manifest.digest !== `sha256:${createHash("sha256").update(canonicalProviderPackJson(input.manifest.payload)).digest("hex")}`
    || !digest.test(proxy ?? "") || !/^[a-f0-9]{40}$/.test(revision)
    || !input.runnerInstanceId || !input.environmentLeaseId) return false;
  const selected: Selection = {
    admittedRunId: actual.runId,
    companyId: actual.companyId, agentId: actual.agentId, sessionId: actual.sessionId,
    runnerInstanceId: input.runnerInstanceId, environmentLeaseId: input.environmentLeaseId,
    providerPackDigest: input.manifest.digest, opencodeProxySha256: proxy!, sourceRevision: revision,
  };
  return rememberSelection(session, selected);
}

export async function rememberRecoveredNativeProviderPack(db: Db, session: NativeSession, input: {
  identity: NativeRunIdentity;
  sourceRunId: string;
  runnerInstanceId: string;
  environmentLeaseId: string;
}): Promise<boolean> {
  if (typeof session.identity !== "function") return false;
  if (canonicalProviderPackJson(session.identity()) !== canonicalProviderPackJson(input.identity)) return false;
  const [source] = await db.select({ receipt: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'nativeProviderPackAdmission'` })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.sourceRunId), eq(heartbeatRuns.companyId, input.identity.companyId),
      eq(heartbeatRuns.agentId, input.identity.agentId), eq(heartbeatRuns.runtimeMode, "native"))).limit(1);
  const value = source?.receipt;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const keys = new Set(["schema", "stage", "authority", "companyId", "agentId", "runId", "sessionId", "runnerInstanceId",
    "environmentLeaseId", "providerPackDigest", "opencodeProxySha256", "sourceRevision", "inheritedFromRunId"]);
  if (Object.keys(receipt).some(key => !keys.has(key)) || receipt.schema !== "paperclip.native-provider-pack-admission.v1"
    || receipt.stage !== "session_admitted" || receipt.authority !== "core_verified_selection"
    || receipt.runId !== input.sourceRunId || receipt.companyId !== input.identity.companyId || receipt.agentId !== input.identity.agentId
    || receipt.sessionId !== input.identity.sessionId || receipt.runnerInstanceId !== input.runnerInstanceId
    || receipt.environmentLeaseId !== input.environmentLeaseId || !digest.test(String(receipt.providerPackDigest))
    || !digest.test(String(receipt.opencodeProxySha256)) || !/^[a-f0-9]{40}$/.test(String(receipt.sourceRevision))
    || (receipt.inheritedFromRunId !== undefined && (typeof receipt.inheritedFromRunId !== "string" || !receipt.inheritedFromRunId))) return false;
  return rememberSelection(session, { admittedRunId: String(receipt.inheritedFromRunId ?? receipt.runId),
    companyId: input.identity.companyId, agentId: input.identity.agentId, sessionId: input.identity.sessionId,
    runnerInstanceId: input.runnerInstanceId, environmentLeaseId: input.environmentLeaseId,
    providerPackDigest: String(receipt.providerPackDigest), opencodeProxySha256: String(receipt.opencodeProxySha256),
    sourceRevision: String(receipt.sourceRevision) });
}

export function admittedNativeProviderPack(session: NativeSession, identity: NativeRunIdentity): NativeProviderPackAdmission | null {
  const selected = admitted.get(session);
  if (!selected) return null;
  const actual = session.identity();
  if (canonicalProviderPackJson(actual) !== canonicalProviderPackJson(identity)
    || actual.companyId !== selected.companyId || actual.agentId !== selected.agentId || actual.sessionId !== selected.sessionId) return null;
  const { admittedRunId, ...identityFields } = selected;
  return { schema: "paperclip.native-provider-pack-admission.v1", stage: "session_admitted",
    authority: "core_verified_selection", ...identityFields, runId: actual.runId,
    ...(admittedRunId === actual.runId ? {} : { inheritedFromRunId: admittedRunId }) };
}

export async function recordNativeProviderPackAdmission(db: Db, input: {
  session: NativeSession;
  identity: NativeRunIdentity;
  claim: { leaseOwner: string; attempt: number; controllerGeneration: number; controllerBootId: string };
}): Promise<boolean> {
  const receipt = admittedNativeProviderPack(input.session, input.identity);
  if (!receipt) return false;
  return db.transaction(async tx => {
    const [owner] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.runId, receipt.runId), eq(nativeRunFinalizations.companyId, receipt.companyId),
      eq(nativeRunFinalizations.issueId, input.identity.issueId), eq(nativeRunFinalizations.leaseOwner, input.claim.leaseOwner),
      eq(nativeRunFinalizations.attempt, input.claim.attempt), eq(nativeRunFinalizations.controllerGeneration, input.claim.controllerGeneration),
      eq(nativeRunFinalizations.controllerBootId, input.claim.controllerBootId), gt(nativeRunFinalizations.leaseExpiresAt, sql`now()`),
      eq(nativeRunFinalizations.phase, "observed"), isNull(nativeRunFinalizations.resultId),
    )).for("update", { noWait: true }).limit(1);
    if (!owner) return false;
    const [run] = await tx.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, receipt.runId), eq(heartbeatRuns.companyId, receipt.companyId),
      eq(heartbeatRuns.agentId, receipt.agentId), eq(heartbeatRuns.nativeIssueId, input.identity.issueId),
      eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"),
    )).for("update", { noWait: true }).limit(1);
    if (!run) return false;
    const previous = run.profile?.nativeProviderPackAdmission;
    if (previous != null) {
      if (canonicalProviderPackJson({ ...(previous as Record<string, unknown>), inheritedFromRunId: null })
        !== canonicalProviderPackJson({ ...receipt, inheritedFromRunId: null })) throw new NativeProviderPackAdmissionConflictError();
      return true;
    }
    const saved = await tx.update(heartbeatRuns).set({
      runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({ nativeProviderPackAdmission: receipt })}::jsonb`,
      updatedAt: new Date(),
    }).where(and(eq(heartbeatRuns.id, receipt.runId), eq(heartbeatRuns.companyId, receipt.companyId),
      eq(heartbeatRuns.agentId, receipt.agentId), eq(heartbeatRuns.nativeIssueId, input.identity.issueId),
      eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"),
    )).returning({ id: heartbeatRuns.id });
    return saved.length === 1;
  });
}
