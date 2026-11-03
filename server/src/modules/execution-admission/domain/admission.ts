/** Referenced projects are rejected beyond this bound instead of admitting a subset. */
export const MAX_ADMISSION_PROJECTS = 100;
const MAX_CONTEXT_REVISION_LENGTH = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AdmissionRecordInput = {
  primaryProjectId: string | null;
  referencedProjectIds: readonly string[];
  contextRevision: string;
};

/**
 * `projectIds` is the complete distinct set in canonical lock order. Lowercase
 * UUID text order matches PostgreSQL uuid order. An empty set is valid and
 * charges no project.
 */
export type AdmissionRecord = {
  primaryProjectId: string | null;
  projectIds: string[];
  contextRevision: string;
};

export type AdmissionRecordResult =
  | { kind: "ok"; record: AdmissionRecord }
  | { kind: "invalid_project_id" }
  | { kind: "too_many_projects"; count: number; limit: number }
  | { kind: "invalid_context_revision" };

export function prepareAdmissionRecord(input: AdmissionRecordInput): AdmissionRecordResult {
  const contextRevision = input.contextRevision.trim();
  if (!contextRevision || contextRevision.length > MAX_CONTEXT_REVISION_LENGTH) return { kind: "invalid_context_revision" };
  const primaryProjectId = input.primaryProjectId?.toLowerCase() ?? null;
  const candidates = [...input.referencedProjectIds, ...(primaryProjectId === null ? [] : [primaryProjectId])].map(id => id.toLowerCase());
  if (candidates.some(id => !UUID.test(id))) return { kind: "invalid_project_id" };
  const projectIds = [...new Set(candidates)].sort();
  if (projectIds.length > MAX_ADMISSION_PROJECTS) {
    return { kind: "too_many_projects", count: projectIds.length, limit: MAX_ADMISSION_PROJECTS };
  }
  return { kind: "ok", record: { primaryProjectId, projectIds, contextRevision } };
}

export function sameAdmissionRecord(left: AdmissionRecord, right: AdmissionRecord) {
  return left.primaryProjectId === right.primaryProjectId && left.contextRevision === right.contextRevision
    && left.projectIds.length === right.projectIds.length && left.projectIds.every((id, index) => id === right.projectIds[index]);
}

export type SettlementDecision = "settle" | "already_settled" | "settled_by_other";

/** A settlement identity can be replayed; a second, different settlement cannot take over. */
export function decideSettlement(existingSettlementId: string | null, settlementId: string): SettlementDecision {
  if (existingSettlementId === null) return "settle";
  return existingSettlementId === settlementId ? "already_settled" : "settled_by_other";
}
