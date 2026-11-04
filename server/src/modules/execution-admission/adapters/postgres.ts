import {
  executionAdmissionProjectCharges as charges,
  executionAdmissions as admissions,
  heartbeatRuns,
  projectTaskExecutionPolicies as policies,
  projects,
  type Db,
} from "@paperclipai/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { TaskExecutionPolicyStore } from "../application/policy.js";
import { decideSettlement, retainedSessionProjects, sameAdmissionRecord, type AdmissionRecord, type AdmittedProjectSet,
  type RetainedSessionProjects } from "../domain/admission.js";
import { ABSENT_TASK_EXECUTION_POLICY, type TaskExecutionPolicy } from "../domain/policy.js";

function assertTransaction(tx: Db) {
  if (!("nestedIndex" in tx)) throw new Error("Execution admission storage requires a database transaction");
}

/**
 * Global lock order step 3: locks the whole project set in ascending ID order
 * in one statement. Returns the IDs that are not projects of the company.
 */
export async function lockAdmissionProjects(tx: Db, companyId: string, projectIds: readonly string[]) {
  assertTransaction(tx);
  if (projectIds.length === 0) return [];
  const rows = await tx.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.companyId, companyId), inArray(projects.id, [...projectIds])))
    .orderBy(asc(projects.id)).for("no key update");
  const found = new Set(rows.map(row => row.id));
  return projectIds.filter(id => !found.has(id));
}

function toPolicy(row: { maxConcurrentTasks: number | null } | undefined): TaskExecutionPolicy {
  return row ? { state: "configured", maxConcurrentTasks: row.maxConcurrentTasks } : ABSENT_TASK_EXECUTION_POLICY;
}

export function createPostgresTaskExecutionPolicyStore(db: Db): TaskExecutionPolicyStore {
  return {
    async read({ companyId, projectId }) {
      const [row] = await db.select({ configured: policies.projectId, maxConcurrentTasks: policies.maxConcurrentTasks })
        .from(projects).leftJoin(policies, eq(policies.projectId, projects.id))
        .where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)));
      if (!row) return null;
      return row.configured ? toPolicy(row) : ABSENT_TASK_EXECUTION_POLICY;
    },

    update: ({ companyId, projectId }, change) => db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      if ((await lockAdmissionProjects(tx, companyId, [projectId])).length > 0) return null;
      const [row] = await tx.select({ maxConcurrentTasks: policies.maxConcurrentTasks }).from(policies)
        .where(eq(policies.projectId, projectId));
      const current = toPolicy(row);
      const next = change(current);
      if (next === current) return current;
      if (next.state === "absent") throw new Error("A stored task execution policy cannot become absent");
      await tx.insert(policies).values({ projectId, companyId, maxConcurrentTasks: next.maxConcurrentTasks })
        .onConflictDoUpdate({ target: policies.projectId, set: { maxConcurrentTasks: next.maxConcurrentTasks, updatedAt: sql`now()` } });
      return next;
    }),
  };
}

export type RecordAdmissionInput = { companyId: string; runId: string; admissionId: string; record: AdmissionRecord };

export type RecordAdmissionOutcome =
  | { kind: "recorded" | "replayed"; attempt: number }
  | { kind: "projects_unavailable"; projectIds: string[] }
  | { kind: "run_not_found" }
  | { kind: "run_already_admitted"; admissionId: string }
  | { kind: "admission_settled" }
  | { kind: "admission_conflict" };

/**
 * Storage transition only: persists one admission attempt and its charges in
 * the caller's transaction. It neither checks capacity nor claims work; the
 * composed admission command must do both under the same locks. Takes lock
 * steps 3 (projects) and 6 (run); composed callers take them earlier.
 */
export async function recordAdmission(tx: Db, input: RecordAdmissionInput): Promise<RecordAdmissionOutcome> {
  assertTransaction(tx);
  const { companyId, runId, admissionId, record } = input;
  const missing = await lockAdmissionProjects(tx, companyId, record.projectIds);
  if (missing.length > 0) return { kind: "projects_unavailable", projectIds: missing };
  const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))).for("no key update");
  if (!run) return { kind: "run_not_found" };

  const [existing] = await tx.select().from(admissions).where(eq(admissions.id, admissionId));
  if (existing) {
    if (existing.companyId !== companyId || existing.runId !== runId) return { kind: "admission_conflict" };
    if (existing.settledAt) return { kind: "admission_settled" };
    const stored = { primaryProjectId: existing.primaryProjectId, contextRevision: existing.contextRevision,
      projectIds: existing.admittedProjectIds ?? [] };
    return sameAdmissionRecord(stored, record) ? { kind: "replayed", attempt: existing.attempt } : { kind: "admission_conflict" };
  }
  const [live] = await tx.select({ id: admissions.id }).from(admissions)
    .where(and(eq(admissions.runId, runId), isNull(admissions.settledAt)));
  if (live) return { kind: "run_already_admitted", admissionId: live.id };

  const [{ attempt }] = await tx.select({ attempt: sql<number>`coalesce(max(${admissions.attempt}), 0)::int + 1` })
    .from(admissions).where(eq(admissions.runId, runId));
  await tx.insert(admissions).values({ id: admissionId, companyId, runId, attempt,
    primaryProjectId: record.primaryProjectId, contextRevision: record.contextRevision, admittedProjectIds: record.projectIds });
  if (record.projectIds.length > 0) {
    await tx.insert(charges).values(record.projectIds.map(projectId => ({ admissionId, companyId, projectId })));
  }
  return { kind: "recorded", attempt };
}

export type SettleAdmissionOutcome =
  | { kind: "settled"; releasedProjectIds: string[] }
  | { kind: "already_settled" | "settled_by_other" | "not_found" };

/**
 * Storage transition only: releases the admission's whole charge set once and
 * keeps its admitted project set. Callers must first verify authoritative
 * lifecycle facts. Takes no project lock.
 */
export async function settleAdmission(tx: Db, input: { companyId: string; admissionId: string; settlementId: string }):
Promise<SettleAdmissionOutcome> {
  assertTransaction(tx);
  const { companyId, admissionId, settlementId } = input;
  const [row] = await tx.select({ settlementId: admissions.settlementId }).from(admissions)
    .where(and(eq(admissions.companyId, companyId), eq(admissions.id, admissionId))).for("no key update");
  if (!row) return { kind: "not_found" };
  const decision = decideSettlement(row.settlementId, settlementId);
  if (decision !== "settle") return { kind: decision };
  const released = await tx.delete(charges)
    .where(and(eq(charges.companyId, companyId), eq(charges.admissionId, admissionId)))
    .returning({ projectId: charges.projectId });
  await tx.update(admissions).set({ settlementId, settledAt: sql`now()` }).where(eq(admissions.id, admissionId));
  return { kind: "settled", releasedProjectIds: released.map(charge => charge.projectId).sort() };
}

export type AdmittedProjectsRead =
  | { kind: "found"; runId: string; attempt: number; primaryProjectId: string | null; contextRevision: string;
    settled: boolean; projects: AdmittedProjectSet }
  | { kind: "not_found" };

/** The admission's complete admitted set, settled or not, for retained-session resolution. */
export async function readAdmittedProjects(db: Db, scope: { companyId: string; admissionId: string }): Promise<AdmittedProjectsRead> {
  const [row] = await db.select().from(admissions)
    .where(and(eq(admissions.companyId, scope.companyId), eq(admissions.id, scope.admissionId)));
  if (!row) return { kind: "not_found" };
  return { kind: "found", runId: row.runId, attempt: row.attempt, primaryProjectId: row.primaryProjectId,
    contextRevision: row.contextRevision, settled: row.settledAt !== null,
    projects: row.admittedProjectIds ? { kind: "known", projectIds: row.admittedProjectIds } : { kind: "unknown" } };
}

/**
 * The set a retained provider session still carries: the latest admission of
 * the session's last run, union the current references. No admission for that
 * run, or a set settled before sets were kept, requires a fresh context.
 */
export async function readRetainedSessionProjects(db: Db, scope: { companyId: string; runId: string },
  currentProjectIds: readonly string[]): Promise<RetainedSessionProjects> {
  const [row] = await db.select({ projectIds: admissions.admittedProjectIds }).from(admissions)
    .where(and(eq(admissions.companyId, scope.companyId), eq(admissions.runId, scope.runId)))
    .orderBy(desc(admissions.attempt)).limit(1);
  return retainedSessionProjects(row?.projectIds ? { kind: "known", projectIds: row.projectIds } : { kind: "unknown" }, currentProjectIds);
}

/** Active charge counts per project. Every stored charge is unsettled. */
export async function countActiveProjectCharges(db: Db, companyId: string, projectIds: readonly string[]) {
  const counts = new Map(projectIds.map(id => [id, 0]));
  if (projectIds.length === 0) return counts;
  const rows = await db.select({ projectId: charges.projectId, active: sql<number>`count(*)::int` }).from(charges)
    .where(and(eq(charges.companyId, companyId), inArray(charges.projectId, [...projectIds])))
    .groupBy(charges.projectId);
  for (const row of rows) counts.set(row.projectId, row.active);
  return counts;
}

/** Project deletion holds the project row lock, so no charge can be added concurrently. */
export async function hasUnsettledProjectCharges(db: Db, scope: { companyId: string; projectId: string }) {
  const [row] = await db.select({ admissionId: charges.admissionId }).from(charges)
    .where(and(eq(charges.companyId, scope.companyId), eq(charges.projectId, scope.projectId))).limit(1);
  return Boolean(row);
}

/** Removes settled history of an agent's runs before they are deleted; refuses while any admission is unsettled. */
export async function deleteAgentAdmissionHistory(tx: Db, scope: { companyId: string; agentId: string }) {
  assertTransaction(tx);
  const agentRuns = tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId)));
  const [live] = await tx.select({ id: admissions.id }).from(admissions)
    .where(and(eq(admissions.companyId, scope.companyId), inArray(admissions.runId, agentRuns), isNull(admissions.settledAt)))
    .limit(1);
  if (live) return { kind: "unsettled" as const };
  await tx.delete(admissions).where(and(eq(admissions.companyId, scope.companyId), inArray(admissions.runId, agentRuns)));
  return { kind: "deleted" as const };
}

