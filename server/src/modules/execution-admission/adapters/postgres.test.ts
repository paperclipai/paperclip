import { randomUUID } from "node:crypto";
import {
  agents,
  companies,
  createDb,
  executionAdmissionProjectCharges as charges,
  executionAdmissions as admissions,
  heartbeatRuns,
  issues,
  projectTaskExecutionPolicies as policies,
  projects,
} from "@paperclipai/db";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { withAccountingTransaction } from "../../../services/accounting-transaction.js";
import { deleteAgentDependencies } from "../../../services/agent-deletion.js";
import { deleteCompany } from "../../../services/company-deletion.js";
import { projectService } from "../../../services/projects.js";
import { prepareAdmissionRecord, retainedSessionProjects, type AdmissionRecord } from "../domain/admission.js";
import { createExecutionAdmission } from "../index.js";
import { countActiveProjectCharges, readAdmittedProjects, recordAdmission, settleAdmission } from "./postgres.js";

const support = await getEmbeddedPostgresTestSupport();
type TestDb = ReturnType<typeof createDb>;

function record(primaryProjectId: string | null, referencedProjectIds: string[], contextRevision = "issue:1") {
  const result = prepareAdmissionRecord({ primaryProjectId, referencedProjectIds, contextRevision });
  if (result.kind !== "ok") throw new Error(result.kind);
  return result.record;
}

describe.skipIf(!support.supported)("execution admission storage", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: TestDb;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("execution-admission-");
    db = createDb(database.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Admission fixture", issuePrefix: `A${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Admission agent", adapterType: "process" }).returning();
    const projectRows = await db.insert(projects).values(["Design", "Docs", "Unlimited"].map(name => ({ companyId: company.id, name })))
      .returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id }).returning();
    return { companyId: company.id, agentId: agent.id, projectIds: projectRows.map(row => row.id).sort(), runId: run.id };
  }

  const inTransaction = <T>(work: (tx: TestDb) => Promise<T>) => db.transaction(tx => work(tx as unknown as TestDb));
  const admit = (input: { companyId: string; runId: string; admissionId?: string; record: AdmissionRecord }) =>
    inTransaction(tx => recordAdmission(tx, { ...input, admissionId: input.admissionId ?? randomUUID() }));
  const settle = (companyId: string, admissionId: string, settlementId = randomUUID()) =>
    inTransaction(tx => settleAdmission(tx, { companyId, admissionId, settlementId }));
  const chargedProjects = async (admissionId: string) => (await db.select({ projectId: charges.projectId }).from(charges)
    .where(eq(charges.admissionId, admissionId)).orderBy(asc(charges.projectId))).map(row => row.projectId);

  it("stores absent, explicit unlimited and positive maximums with partial updates", async () => {
    const { companyId, projectIds: [projectId] } = await fixture();
    const policy = createExecutionAdmission(db);
    const scope = { companyId, projectId };
    expect(await policy.readTaskExecutionPolicy(scope)).toEqual({ kind: "found", policy: { state: "absent", maxConcurrentTasks: null } });
    expect(await policy.updateTaskExecutionPolicy(scope, {})).toMatchObject({ kind: "unchanged", policy: { state: "absent" } });
    expect(await db.select().from(policies)).not.toContainEqual(expect.objectContaining({ projectId }));

    expect(await policy.updateTaskExecutionPolicy(scope, { maxConcurrentTasks: 2 }))
      .toEqual({ kind: "updated", policy: { state: "configured", maxConcurrentTasks: 2 } });
    expect(await policy.updateTaskExecutionPolicy(scope, undefined)).toMatchObject({ kind: "unchanged", policy: { maxConcurrentTasks: 2 } });
    expect(await policy.updateTaskExecutionPolicy(scope, { maxConcurrentTasks: 0 })).toMatchObject({ kind: "invalid" });
    expect(await policy.updateTaskExecutionPolicy(scope, null))
      .toEqual({ kind: "updated", policy: { state: "configured", maxConcurrentTasks: null } });
    expect(await policy.readTaskExecutionPolicy(scope)).toEqual({ kind: "found", policy: { state: "configured", maxConcurrentTasks: null } });

    const foreign = { companyId: (await fixture()).companyId, projectId };
    expect(await policy.readTaskExecutionPolicy(foreign)).toEqual({ kind: "project_not_found" });
    expect(await policy.updateTaskExecutionPolicy(foreign, { maxConcurrentTasks: 1 })).toEqual({ kind: "project_not_found" });
    expect(await policy.readTaskExecutionPolicy(scope)).toMatchObject({ policy: { maxConcurrentTasks: null } });
  });

  it("enforces policy constraints and company scope in the database", async () => {
    const { companyId, projectIds: [projectId] } = await fixture();
    const other = await fixture();
    await expect(db.insert(policies).values({ companyId, projectId, maxConcurrentTasks: 0 }))
      .rejects.toMatchObject({ cause: { constraint_name: "project_task_execution_policies_maximum_check" } });
    await expect(db.insert(policies).values({ companyId: other.companyId, projectId, maxConcurrentTasks: 1 }))
      .rejects.toMatchObject({ cause: { constraint_name: "project_task_execution_policies_company_project_fk" } });
  });

  it("charges every distinct project, including unlimited and primaryless sets", async () => {
    const { companyId, runId, projectIds: [a, b, c] } = await fixture();
    await createExecutionAdmission(db).updateTaskExecutionPolicy({ companyId, projectId: c }, null);
    const admissionId = randomUUID();
    const admitted = record(a, [c, b, a]);
    expect(await admit({ companyId, runId, admissionId, record: admitted })).toEqual({ kind: "recorded", attempt: 1 });
    expect(await chargedProjects(admissionId)).toEqual([a, b, c]);
    const [epoch] = await db.select().from(admissions).where(eq(admissions.id, admissionId));
    expect(epoch).toMatchObject({ companyId, runId, attempt: 1, primaryProjectId: a, contextRevision: "issue:1", settlementId: null });

    const other = await fixture();
    const primaryless = randomUUID();
    expect(await admit({ ...other, admissionId: primaryless, record: record(null, [other.projectIds[1]]) }))
      .toMatchObject({ kind: "recorded" });
    expect(await chargedProjects(primaryless)).toEqual([other.projectIds[1]]);

    const empty = await fixture();
    const emptyId = randomUUID();
    expect(await admit({ ...empty, admissionId: emptyId, record: record(null, []) })).toMatchObject({ kind: "recorded" });
    expect(await chargedProjects(emptyId)).toEqual([]);
    expect([...(await countActiveProjectCharges(db, empty.companyId, empty.projectIds)).values()]).toEqual([0, 0, 0]);
  });

  it("replays one admission identity and refuses a second live epoch for the run", async () => {
    const { companyId, runId, projectIds: [a, b] } = await fixture();
    const admissionId = randomUUID();
    const admitted = record(a, [b]);
    await admit({ companyId, runId, admissionId, record: admitted });
    expect(await admit({ companyId, runId, admissionId, record: admitted })).toEqual({ kind: "replayed", attempt: 1 });
    expect(await admit({ companyId, runId, admissionId, record: record(a, []) })).toEqual({ kind: "admission_conflict" });
    expect(await admit({ companyId, runId, admissionId, record: record(a, [b], "issue:2") })).toEqual({ kind: "admission_conflict" });
    expect(await admit({ companyId, runId, record: admitted })).toEqual({ kind: "run_already_admitted", admissionId });
    expect(await db.select({ id: admissions.id }).from(admissions).where(eq(admissions.runId, runId))).toHaveLength(1);
    await expect(db.insert(admissions).values({ id: randomUUID(), companyId, runId, attempt: 2, contextRevision: "x", admittedProjectIds: [] }))
      .rejects.toMatchObject({ cause: { constraint_name: "execution_admissions_live_run_uq" } });
  });

  it("settles the whole set once and starts a new attempt for the same run", async () => {
    const { companyId, runId, projectIds: [a, b] } = await fixture();
    const first = randomUUID();
    await admit({ companyId, runId, admissionId: first, record: record(a, [b]) });
    const settlementId = randomUUID();
    expect(await settle(companyId, first, settlementId)).toEqual({ kind: "settled", releasedProjectIds: [a, b] });
    expect(await settle(companyId, first, settlementId)).toEqual({ kind: "already_settled" });
    expect(await settle(companyId, first)).toEqual({ kind: "settled_by_other" });
    expect(await settle(randomUUID(), first)).toEqual({ kind: "not_found" });
    expect(await chargedProjects(first)).toEqual([]);
    expect(await admit({ companyId, runId, admissionId: first, record: record(a, [b]) })).toEqual({ kind: "admission_settled" });

    const second = randomUUID();
    expect(await admit({ companyId, runId, admissionId: second, record: record(a, [], "issue:2") })).toEqual({ kind: "recorded", attempt: 2 });
    expect(await db.select({ attempt: admissions.attempt, settled: sql<boolean>`${admissions.settledAt} is not null` })
      .from(admissions).where(eq(admissions.runId, runId)).orderBy(asc(admissions.attempt)))
      .toEqual([{ attempt: 1, settled: true }, { attempt: 2, settled: false }]);
    await expect(db.update(admissions).set({ settlementId: randomUUID() }).where(eq(admissions.id, second)))
      .rejects.toMatchObject({ cause: { constraint_name: "execution_admissions_settlement_check" } });
  });

  it("keeps each admitted set readable after settlement releases its capacity", async () => {
    const { companyId, agentId, runId, projectIds: [a, b, c] } = await fixture();
    const first = randomUUID();
    await admit({ companyId, runId, admissionId: first, record: record(a, [b]) });
    const settlementId = randomUUID();
    await settle(companyId, first, settlementId);
    const settledRead = { kind: "found", runId, attempt: 1, primaryProjectId: a, contextRevision: "issue:1", settled: true,
      projects: { kind: "known", projectIds: [a, b] } };
    expect(await chargedProjects(first)).toEqual([]);
    expect(Object.fromEntries(await countActiveProjectCharges(db, companyId, [a, b]))).toEqual({ [a]: 0, [b]: 0 });
    expect(await readAdmittedProjects(db, { companyId, admissionId: first })).toEqual(settledRead);
    expect(await settle(companyId, first, settlementId)).toEqual({ kind: "already_settled" });
    expect(await readAdmittedProjects(db, { companyId, admissionId: first })).toEqual(settledRead);

    // B was removed from the task text; the retained session still carries it.
    const second = randomUUID();
    await admit({ companyId, runId, admissionId: second, record: record(a, [c], "issue:2") });
    expect(await readAdmittedProjects(db, { companyId, admissionId: second }))
      .toMatchObject({ attempt: 2, settled: false, projects: { kind: "known", projectIds: [a, c] } });
    expect(retainedSessionProjects(settledRead.projects as { kind: "known"; projectIds: string[] }, [a]))
      .toEqual({ kind: "retain", projectIds: [a, b] });
    expect(retainedSessionProjects({ kind: "unknown" }, [a])).toEqual({ kind: "fresh_context_required" });

    const [otherRun, emptyRun] = await db.insert(heartbeatRuns).values([{ companyId, agentId }, { companyId, agentId }]).returning();
    const primaryless = randomUUID(), empty = randomUUID();
    await admit({ companyId, runId: otherRun.id, admissionId: primaryless, record: record(null, [b]) });
    await admit({ companyId, runId: emptyRun.id, admissionId: empty, record: record(null, []) });
    await settle(companyId, primaryless);
    await settle(companyId, empty);
    expect(await readAdmittedProjects(db, { companyId, admissionId: primaryless }))
      .toMatchObject({ primaryProjectId: null, projects: { kind: "known", projectIds: [b] } });
    expect(await readAdmittedProjects(db, { companyId, admissionId: empty })).toMatchObject({ projects: { kind: "known", projectIds: [] } });
    expect(await readAdmittedProjects(db, { companyId: (await fixture()).companyId, admissionId: first })).toEqual({ kind: "not_found" });

    await expect(db.update(admissions).set({ admittedProjectIds: [a] }).where(eq(admissions.id, first)))
      .rejects.toMatchObject({ cause: { message: "execution admission project set is immutable" } });
    await expect(db.insert(admissions).values({ id: randomUUID(), companyId, runId: emptyRun.id, attempt: 9, contextRevision: "x" }))
      .rejects.toMatchObject({ cause: { constraint_name: "execution_admissions_project_set_check" } });

    // Settled history neither blocks deleting B nor loses its identity.
    expect(await projectService(db).remove(b)).toMatchObject({ id: b });
    expect(await readAdmittedProjects(db, { companyId, admissionId: first })).toEqual(settledRead);
    await expect(projectService(db).remove(c)).rejects.toMatchObject({ details: { code: "project_execution_admission_pending" } });
  });

  it("keeps company isolation and rolls back the whole record", async () => {
    const { companyId, runId, projectIds: [a] } = await fixture();
    const other = await fixture();
    expect(await admit({ companyId, runId, record: record(a, [other.projectIds[0]]) }))
      .toEqual({ kind: "projects_unavailable", projectIds: [other.projectIds[0]] });
    expect(await admit({ companyId, runId: other.runId, record: record(a, []) })).toEqual({ kind: "run_not_found" });
    const admissionId = randomUUID();
    await admit({ companyId, runId, admissionId, record: record(a, []) });
    expect(await admit({ companyId: other.companyId, runId: other.runId, admissionId, record: record(null, []) }))
      .toEqual({ kind: "admission_conflict" });
    await expect(db.insert(charges).values({ admissionId, companyId, projectId: other.projectIds[0] }))
      .rejects.toMatchObject({ cause: { constraint_name: "execution_admission_project_charges_company_project_fk" } });
    await expect(db.insert(charges).values({ admissionId, companyId, projectId: a }))
      .rejects.toMatchObject({ cause: { constraint_name: "execution_admission_project_charges_admission_id_project_id_pk" } });

    const rolledBack = randomUUID();
    await expect(inTransaction(async tx => {
      await recordAdmission(tx, { companyId: other.companyId, runId: other.runId, admissionId: rolledBack, record: record(null, other.projectIds) });
      throw new Error("claim lost");
    })).rejects.toThrow("claim lost");
    expect(await readAdmittedProjects(db, { companyId: other.companyId, admissionId: rolledBack })).toEqual({ kind: "not_found" });
    expect(await chargedProjects(rolledBack)).toEqual([]);
    await expect(recordAdmission(db, { companyId, runId, admissionId: randomUUID(), record: record(a, []) }))
      .rejects.toThrow("requires a database transaction");
  });

  it("counts active charges per project through the project index", async () => {
    const first = await fixture();
    const [a, b, c] = first.projectIds;
    const [secondRun] = await db.insert(heartbeatRuns).values({ companyId: first.companyId, agentId: first.agentId }).returning();
    const held = randomUUID();
    await admit({ ...first, admissionId: held, record: record(a, [b]) });
    await admit({ companyId: first.companyId, runId: secondRun.id, record: record(null, [a]) });
    expect(Object.fromEntries(await countActiveProjectCharges(db, first.companyId, [a, b, c]))).toEqual({ [a]: 2, [b]: 1, [c]: 0 });
    await settle(first.companyId, held);
    expect(Object.fromEntries(await countActiveProjectCharges(db, first.companyId, [a, b, c]))).toEqual({ [a]: 1, [b]: 0, [c]: 0 });
    expect(Object.fromEntries(await countActiveProjectCharges(db, randomUUID(), [a]))).toEqual({ [a]: 0 });

    const plan = await inTransaction(async tx => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute(sql`explain select project_id, count(*) from execution_admission_project_charges
        where company_id = ${first.companyId} and project_id in (${a}, ${b}) group by project_id`);
    });
    expect(JSON.stringify(plan)).toContain("execution_admission_project_charges_project_idx");
  });

  it("preserves unsettled charges through project archive and delete", async () => {
    const { companyId, runId, projectIds: [a, b] } = await fixture();
    const admissionId = randomUUID();
    await admit({ companyId, runId, admissionId, record: record(a, [b]) });
    const projectsService = projectService(db);
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, b));
    expect(await chargedProjects(admissionId)).toEqual([a, b]);
    await expect(projectsService.remove(a)).rejects.toMatchObject({ status: 409, details: { code: "project_execution_admission_pending" } });
    await expect(db.delete(projects).where(eq(projects.id, b)))
      .rejects.toMatchObject({ cause: { constraint_name: "execution_admission_project_charges_company_project_fk" } });
    expect(await chargedProjects(admissionId)).toEqual([a, b]);

    await createExecutionAdmission(db).updateTaskExecutionPolicy({ companyId, projectId: a }, { maxConcurrentTasks: 1 });
    await settle(companyId, admissionId);
    expect(await projectsService.remove(a)).toMatchObject({ id: a });
    expect(await db.select().from(policies).where(eq(policies.projectId, a))).toEqual([]);
    expect(await db.select({ primaryProjectId: admissions.primaryProjectId }).from(admissions).where(eq(admissions.id, admissionId)))
      .toEqual([{ primaryProjectId: a }]);
  });

  it.each(["creator", "assignee", "both", "neither"] as const)("clears only deleted agent issue references: %s", async (reference) => {
    const { companyId, agentId } = await fixture();
    const [survivor] = await db.insert(agents).values({ companyId, name: "Surviving agent", adapterType: "process" }).returning();
    const assigneeAgentId = reference === "assignee" || reference === "both" ? agentId : survivor.id;
    const createdByAgentId = reference === "creator" || reference === "both" ? agentId : survivor.id;
    const [issue] = await db.insert(issues).values({ companyId, title: "Shared issue", assigneeAgentId, createdByAgentId }).returning();

    await withAccountingTransaction(db, companyId, tx => deleteAgentDependencies(tx, companyId, agentId));

    expect(await db.select({ assigneeAgentId: issues.assigneeAgentId, createdByAgentId: issues.createdByAgentId })
      .from(issues).where(eq(issues.id, issue.id))).toEqual([{
      assigneeAgentId: assigneeAgentId === agentId ? null : survivor.id,
      createdByAgentId: createdByAgentId === agentId ? null : survivor.id,
    }]);
  });

  it("guards agent deletion while unsettled and removes admissions with the company", async () => {
    const { companyId, agentId, runId, projectIds: [a] } = await fixture();
    const admissionId = randomUUID();
    await admit({ companyId, runId, admissionId, record: record(a, []) });
    await expect(withAccountingTransaction(db, companyId, tx => deleteAgentDependencies(tx, companyId, agentId)))
      .rejects.toMatchObject({ status: 409, details: { code: "agent_execution_admission_pending" } });
    expect(await chargedProjects(admissionId)).toEqual([a]);
    await settle(companyId, admissionId);
    await withAccountingTransaction(db, companyId, tx => deleteAgentDependencies(tx, companyId, agentId));
    expect(await db.select().from(admissions).where(eq(admissions.runId, runId))).toEqual([]);

    const deleted = await fixture();
    const retained = await fixture();
    const retainedAdmission = randomUUID();
    await admit({ ...retained, admissionId: retainedAdmission, record: record(retained.projectIds[0], []) });
    await admit({ ...deleted, record: record(deleted.projectIds[0], deleted.projectIds) });
    await db.update(agents).set({ lifecycleState: "terminated", status: "terminated" }).where(eq(agents.id, deleted.agentId));
    expect(await deleteCompany(db, deleted.companyId)).toMatchObject({ id: deleted.companyId });
    expect(await db.select().from(admissions).where(eq(admissions.companyId, deleted.companyId))).toEqual([]);
    expect(await chargedProjects(retainedAdmission)).toEqual([retained.projectIds[0]]);
  }, 60_000);
});
