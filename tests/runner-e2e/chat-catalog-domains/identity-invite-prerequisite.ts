import type { RunnerApi } from "../api.js";

export const invitationIncident = Object.freeze({
  corePr: "https://github.com/paperclipai/paperclip/pull/17848",
  priorProof: "tests/runner-e2e/results/chat-catalog-campaign/operations/agent-feedback-privacy-cause-68e.json",
  priorProofSha256: "9f0fa4432438411567e51987c0c239f0e0ef9513c0dce80623707486978bfe16",
  affectedBaseline: "8373d7867963674ff960d2345d0d28086f799bc7",
  affectedRedactorSha256: "f1fde1590128fe2fc95a6752e1daf4fe8e0a1478328a50944945597a6aa21315",
  fixedRedactorSha256: "dcc6274253d8954d190c3c43f40a2d1ce6c8c3817a85176f8bd264b677f7ae73",
});
export interface InvitationRuntimeProof {
  apiOrigin: string;
  processStartedAt: string;
  healthCommit: string | null;
  redactorSha256: string;
  serverEntrySha256: string;
  supervisorReceiptSha256: string;
  priorProofSha256: string;
}
export interface InvitationPrerequisiteBinding {
  /** Supervisor owner must independently verify the actual spawned source entry,
   * loaded logger bytes, owned process and retained receipt before returning this.
   * Eval source SHA or an asserted production revision is not sufficient. */
  verifyRuntime(): Promise<InvitationRuntimeProof>;
  evidence(name: string, receipt: InvitationPrerequisiteReceipt): Promise<unknown>;
}
export interface InvitationPrerequisiteReceipt {
  schema: "invitation-enrollment-prerequisite.v1";
  disposition: "blocked-core-prerequisite" | "blocked-runtime-identity" | "incomplete-public-prerequisite";
  phase: "before-invitation-acceptance";
  corePr: string;
  priorProofSha256: string;
  observedRedactorSha256?: string;
  supervisorReceiptSha256?: string;
  inviteId?: string;
  companyId?: string;
  inviteReadback: boolean;
  inviteRevoked: boolean;
  personSessionDisposed: boolean;
  acceptanceCalled: false;
  nativeDispatchFromPrerequisite: false;
}
const bindings = new WeakMap<RunnerApi, InvitationPrerequisiteBinding>();
export function bindInvitationEnrollmentPrerequisite(api: RunnerApi, binding: InvitationPrerequisiteBinding) {
  if (bindings.has(api)) throw new Error("Invitation prerequisite binding is already owned by this attempt");
  bindings.set(api, binding);
}
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function invitationRuntimeDisposition(proof: InvitationRuntimeProof | undefined, origin: string,
  health: { deploymentMode?: string; commit?: string | null; serverInfo?: { processStartedAt?: string } }): "affected" | "qualified-fixed" | "unknown" {
  if (!proof || health.deploymentMode !== "authenticated" || proof.apiOrigin !== origin
    || !proof.processStartedAt || !Number.isFinite(Date.parse(proof.processStartedAt))
    || health.serverInfo?.processStartedAt !== proof.processStartedAt
    || health.commit !== proof.healthCommit || !(proof.healthCommit === null || /^[a-f0-9]{40}$/.test(proof.healthCommit))
    || !hash(proof.serverEntrySha256) || !hash(proof.supervisorReceiptSha256)
    || proof.priorProofSha256 !== invitationIncident.priorProofSha256) return "unknown";
  if (proof.redactorSha256 === invitationIncident.affectedRedactorSha256) return "affected";
  if (proof.redactorSha256 === invitationIncident.fixedRedactorSha256) return "qualified-fixed";
  return "unknown";
}
export class InvitationEnrollmentPrerequisiteBlocked extends Error {
  constructor(readonly receipt: InvitationPrerequisiteReceipt) {
    super(`Invitation enrollment setup blocked before token-path acceptance: ${JSON.stringify(receipt)}`);
    this.name = "InvitationEnrollmentPrerequisiteBlocked";
  }
}
/** Returns only for the independently qualified fixed logger. Otherwise the
 * issued private capability is verified and revoked without ever using its URL. */
export async function requireSafeInvitationEnrollment(api: RunnerApi, companyId: string, inviteId: string, role: "operator" | "viewer", disposePerson: () => Promise<void>) {
  const binding = bindings.get(api);
  let proof: InvitationRuntimeProof | undefined;
  try { proof = await binding?.verifyRuntime(); } catch { /* Unknown identity never authorizes acceptance. */ }
  let disposition: "affected" | "qualified-fixed" | "unknown" = "unknown";
  try {
    const health = await api.get<{ deploymentMode: string; commit: string | null; serverInfo?: { processStartedAt?: string } }>("/api/health");
    disposition = invitationRuntimeDisposition(proof, api.baseURL, health);
  } catch { /* Failure to observe identity cannot authorize token-path access. */ }
  if (disposition === "qualified-fixed") return;
  const receipt: InvitationPrerequisiteReceipt = {
    schema: "invitation-enrollment-prerequisite.v1", disposition: "incomplete-public-prerequisite",
    phase: "before-invitation-acceptance", corePr: invitationIncident.corePr, priorProofSha256: invitationIncident.priorProofSha256,
    ...(disposition === "affected" ? { observedRedactorSha256: proof!.redactorSha256, supervisorReceiptSha256: proof!.supervisorReceiptSha256 } : {}),
    inviteReadback: false, inviteRevoked: false, personSessionDisposed: false, acceptanceCalled: false, nativeDispatchFromPrerequisite: false,
  };
  if (!/^[a-f0-9-]{36}$/.test(inviteId) || !/^[a-f0-9-]{36}$/.test(companyId)) {
    try { await disposePerson(); receipt.personSessionDisposed = true; } catch { /* Keep incomplete cleanup visible. */ }
    await binding?.evidence("identity-invitation-enrollment-prerequisite.json", receipt);
    throw new Error(`Invitation prerequisite probe incomplete: ${JSON.stringify(receipt)}`);
  }
  receipt.inviteId = inviteId; receipt.companyId = companyId;
  try {
    const page = await api.get<{ invites: Array<{ id: string; companyId: string; allowedJoinTypes: string; humanRole: string; state: string }> }>(`/api/companies/${companyId}/invites?limit=100`);
    receipt.inviteReadback = page.invites.some(row => row.id === inviteId && row.companyId === companyId && row.allowedJoinTypes === "human" && row.humanRole === role && row.state === "active");
  } catch { /* The safe receipt records an incomplete public prerequisite. */ }
  try {
    await api.postSensitive(`/api/invites/${inviteId}/revoke`, {});
    const page = await api.get<{ invites: Array<{ id: string; state: string }> }>(`/api/companies/${companyId}/invites?state=revoked&limit=100`);
    receipt.inviteRevoked = page.invites.some(row => row.id === inviteId && row.state === "revoked");
  } catch { /* Cleanup failure must remain visible and cannot count as blocked proof. */ }
  try { await disposePerson(); receipt.personSessionDisposed = true; } catch { /* An incomplete cleanup is never credited as closed proof. */ }
  if (receipt.inviteReadback && receipt.inviteRevoked && receipt.personSessionDisposed) receipt.disposition = disposition === "affected" ? "blocked-core-prerequisite" : "blocked-runtime-identity";
  await binding?.evidence("identity-invitation-enrollment-prerequisite.json", receipt);
  if (!receipt.inviteReadback || !receipt.inviteRevoked || !receipt.personSessionDisposed) throw new Error(`Invitation prerequisite probe incomplete: ${JSON.stringify(receipt)}`);
  throw new InvitationEnrollmentPrerequisiteBlocked(receipt);
}
