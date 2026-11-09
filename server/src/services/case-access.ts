import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { agents, cases, caseAccessSources, caseDocuments, caseEvents, companyMemberships, documentRevisions, documents, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { authorizationService, issueReadSqlCondition, projectReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { isLowTrustQuarantined, resolveActorSourceTrustForIssue } from "./source-trust.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";

type CaseDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type CaseIdentity = { id: string; companyId: string };

const CASE_TRUST_ERROR = "Low-trust work must use its governed review path before writing or executing case work";

function runIssueId(run: { issueId: string | null; nativeIssueId: string | null; contextIssueId: unknown }) {
  const id = run.issueId ?? run.nativeIssueId ?? run.contextIssueId;
  return typeof id === "string" && isUuidLike(id) ? id : null;
}

/** Cases have no artifact promotion surface, so contained runs cannot persist raw output here. */
export async function assertActorCanWriteCase(db: CaseDb, actor: AuthorizationActor, input: {
  companyId: string; projectId?: string | null; workIssueId?: string | null;
}) {
  if (actor.type !== "agent") return;
  if (!actor.agentId || (actor.runId && !isUuidLike(actor.runId))) throw forbidden(CASE_TRUST_ERROR);
  const [run] = actor.runId ? await db.select({
    agentId: heartbeatRuns.agentId, issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId,
    contextIssueId: sql<unknown>`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->'paperclipIssue'->>'id', ${heartbeatRuns.contextSnapshot}->>'taskId')`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actor.runId), eq(heartbeatRuns.companyId, input.companyId))).limit(1) : [];
  if (actor.runId && (!run || run.agentId !== actor.agentId)) throw forbidden(CASE_TRUST_ERROR);
  let sourceId = run ? runIssueId(run) : null;
  if (run && !sourceId && actor.runId) {
    const [source] = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, input.companyId),
      or(eq(issues.executionRunId, actor.runId), eq(issues.checkoutRunId, actor.runId), eq(issues.originRunId, actor.runId)),
    )).limit(1);
    sourceId = source?.id ?? null;
  }
  const issueIds = [...new Set([sourceId, input.workIssueId].filter((id): id is string => !!id))];
  const issueRows = issueIds.length ? await db.select({
    id: issues.id, companyId: issues.companyId, projectId: issues.projectId, executionPolicy: issues.executionPolicy,
  }).from(issues).where(and(eq(issues.companyId, input.companyId), inArray(issues.id, issueIds))) : [];
  if (issueRows.length !== issueIds.length) throw forbidden(CASE_TRUST_ERROR);
  const contexts = [...issueRows, { id: input.companyId, companyId: input.companyId, projectId: input.projectId }];
  for (const issue of contexts) {
    if (await resolveActorSourceTrustForIssue({ db: db as Db, issue, actor: {
      actorType: "agent", actorId: actor.agentId, agentId: actor.agentId, runId: actor.runId ?? null,
    } })) throw forbidden(CASE_TRUST_ERROR);
  }
}

/**
 * Historical cases lack per-field trust metadata. Fail closed before admission
 * when retained boundaries or recorded agent writes cannot establish standard
 * trust; an ordinary handoff is not an artifact-promotion operation.
 * Queries project policies/identities only, never historical document/run bodies.
 */
export async function assertCaseTrustedForExecution(db: CaseDb, identity: CaseIdentity) {
  const [record] = await db.select({ id: cases.id, projectId: cases.projectId, workIssueId: cases.workIssueId,
    createdByAgentId: cases.createdByAgentId }).from(cases).where(and(eq(cases.id, identity.id), eq(cases.companyId, identity.companyId))).limit(1);
  if (!record) throw notFound("Case not found");
  const [sources, events, revisions, documentTrust] = await Promise.all([
    db.select().from(caseAccessSources).where(and(eq(caseAccessSources.caseId, identity.id), eq(caseAccessSources.companyId, identity.companyId))),
    db.selectDistinct({ agentId: caseEvents.actorAgentId, runId: caseEvents.runId }).from(caseEvents)
      .where(and(eq(caseEvents.caseId, identity.id), eq(caseEvents.companyId, identity.companyId), eq(caseEvents.actorType, "agent"))),
    db.selectDistinct({ agentId: documentRevisions.createdByAgentId, runId: documentRevisions.createdByRunId })
      .from(caseDocuments).innerJoin(documentRevisions, eq(documentRevisions.documentId, caseDocuments.documentId))
      .where(and(eq(caseDocuments.caseId, identity.id), eq(caseDocuments.companyId, identity.companyId))),
    db.select({ sourceTrust: documents.sourceTrust }).from(caseDocuments).innerJoin(documents, eq(documents.id, caseDocuments.documentId))
      .where(and(eq(caseDocuments.caseId, identity.id), eq(caseDocuments.companyId, identity.companyId))),
  ]);
  if (documentTrust.some(row => isLowTrustQuarantined(row.sourceTrust))) throw forbidden(CASE_TRUST_ERROR);
  if (events.some(row => !row.agentId && !row.runId)) throw forbidden(CASE_TRUST_ERROR);
  const writes = [...events, ...revisions.filter(row => row.agentId || row.runId)];
  const runIds = [...new Set(writes.map(row => row.runId).filter((id): id is string => !!id))];
  const runs = runIds.length ? await db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId,
    issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId,
    executionPolicy: sql<unknown>`${heartbeatRuns.contextSnapshot}->'executionPolicy'`,
    contextIssueId: sql<unknown>`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->'paperclipIssue'->>'id', ${heartbeatRuns.contextSnapshot}->>'taskId')`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, identity.companyId), inArray(heartbeatRuns.id, runIds))) : [];
  const runMap = new Map(runs.map(row => [row.id, row]));
  if (runs.length !== runIds.length || writes.some(row => row.runId && row.agentId && runMap.get(row.runId)?.agentId !== row.agentId)) throw forbidden(CASE_TRUST_ERROR);
  const agentIds = [...new Set([record.createdByAgentId, ...writes.map(row => row.agentId), ...runs.map(row => row.agentId)].filter((id): id is string => !!id))];
  const agentRows = agentIds.length ? await db.select({ id: agents.id, companyId: agents.companyId, permissions: agents.permissions })
    .from(agents).where(and(eq(agents.companyId, identity.companyId), inArray(agents.id, agentIds))) : [];
  if (agentRows.length !== agentIds.length) throw forbidden(CASE_TRUST_ERROR);
  const issueIds = [...new Set([record.workIssueId, ...sources.filter(row => row.sourceKind === "issue").map(row => row.sourceId), ...runs.map(runIssueId)].filter((id): id is string => !!id))];
  const issueRows = issueIds.length ? await db.select({ id: issues.id, companyId: issues.companyId, projectId: issues.projectId,
    executionPolicy: issues.executionPolicy, sourceTrust: issues.sourceTrust }).from(issues)
    .where(and(eq(issues.companyId, identity.companyId), inArray(issues.id, issueIds))) : [];
  if (issueRows.length !== issueIds.length || issueRows.some(row => isLowTrustQuarantined(row.sourceTrust))) throw forbidden(CASE_TRUST_ERROR);
  const projectIds = [...new Set([record.projectId, ...sources.filter(row => row.sourceKind === "project").map(row => row.sourceId), ...issueRows.map(row => row.projectId)].filter((id): id is string => !!id))];
  const projectRows = projectIds.length ? await db.select({ id: projects.id, companyId: projects.companyId, executionWorkspacePolicy: projects.executionWorkspacePolicy })
    .from(projects).where(and(eq(projects.companyId, identity.companyId), inArray(projects.id, projectIds))) : [];
  if (projectRows.length !== projectIds.length) throw forbidden(CASE_TRUST_ERROR);
  const standard = (resolution: ReturnType<typeof resolveCoreTrustPreset>) => {
    if (resolution.kind !== "standard") throw forbidden(CASE_TRUST_ERROR);
  };
  for (const agent of agentRows) standard(resolveCoreTrustPreset({ companyId: identity.companyId, agent }));
  for (const project of projectRows) standard(resolveCoreTrustPreset({ companyId: identity.companyId, project }));
  for (const issue of issueRows) standard(resolveCoreTrustPreset({ companyId: identity.companyId, issue }));
  for (const run of runs) standard(resolveCoreTrustPreset({ companyId: identity.companyId, run: { companyId: identity.companyId, executionPolicy: run.executionPolicy } }));
}

/** SQL pushdown keeps counts/pagination and direct reads on the same policy. */
export async function caseReadSqlCondition(db: CaseDb, actor: AuthorizationActor): Promise<SQL<boolean>> {
  const [issueCondition, projectCondition] = await Promise.all([
    issueReadSqlCondition(db, actor), projectReadSqlCondition(db, actor),
  ]);
  const ownCompany = actor.type === "agent" && actor.companyId
    ? sql`${cases.companyId} = ${actor.companyId}`
    : actor.type === "board" && (actor.source === "local_implicit" || actor.isInstanceAdmin)
      ? sql`true`
      : actor.type === "board" && actor.userId
        ? sql`exists (select 1 from ${companyMemberships} cm where cm.company_id = ${cases.companyId}
            and cm.principal_type = 'user' and cm.principal_id = ${actor.userId} and cm.status = 'active')`
        : sql`false`;
  const responsibleUsers = actor.type === "agent"
    ? [...new Set([actor.onBehalfOfUserId, actor.authorizingUserId].filter((id): id is string => !!id))] : [];
  const companyCondition = responsibleUsers.reduce((condition, userId) => sql`(${condition} and exists (
      select 1 from ${companyMemberships} cm where cm.company_id = ${cases.companyId}
        and cm.principal_type = 'user' and cm.principal_id = ${userId} and cm.status = 'active'))`, ownCompany);
  return sql<boolean>`(${companyCondition} and not exists (
    select 1 from ${caseAccessSources} retained where retained.case_id = ${cases.id}
      and (retained.company_id <> ${cases.companyId} or not (
        (retained.source_kind = 'issue' and exists (select 1 from ${issues}
          where ${issues.id} = retained.source_id and ${issues.companyId} = ${cases.companyId} and ${issueCondition}))
        or (retained.source_kind = 'project' and exists (select 1 from ${projects}
          where ${projects.id} = retained.source_id and ${projects.companyId} = ${cases.companyId} and ${projectCondition}))
      ))
  ))`;
}

export async function canActorReadCase(db: CaseDb, actor: AuthorizationActor, caseId: string | CaseIdentity): Promise<boolean> {
  const identity = typeof caseId === "string" ? { id: caseId } : caseId;
  if (!isUuidLike(identity.id)) return false;
  const [row] = await db.select({ id: cases.id }).from(cases).where(and(
    eq(cases.id, identity.id), "companyId" in identity ? eq(cases.companyId, identity.companyId) : undefined,
    await caseReadSqlCondition(db, actor),
  )).limit(1);
  return !!row && (await filterCasesForActor(db, actor, [row])).length === 1;
}

/** Full canonical authorization also preserves low-trust and scoped-key restrictions. */
export async function filterCasesForActor<T extends { id: string }>(db: CaseDb, actor: AuthorizationActor, rows: T[]): Promise<T[]> {
  if (!rows.length) return [];
  const sources = await db.select().from(caseAccessSources).where(inArray(caseAccessSources.caseId, rows.map(row => row.id)));
  const access = authorizationService(db);
  const decisions = await access.decideReads(actor, sources.map(source => source.sourceKind === "issue"
    ? { type: "issue" as const, companyId: source.companyId, issueId: source.sourceId }
    : { type: "project" as const, companyId: source.companyId, projectId: source.sourceId }));
  const denied = new Set(sources.filter((_, index) => !decisions[index]?.allowed).map(source => source.caseId));
  // Source-less records are company records: scoped agents must qualify for
  // company discovery instead of treating absent provenance as a broad grant.
  const sourced = new Set(sources.map(source => source.caseId));
  const unsourcedIds = rows.filter(row => !sourced.has(row.id)).map(row => row.id);
  if (unsourcedIds.length) {
    const records = await db.select({ id: cases.id, companyId: cases.companyId }).from(cases).where(inArray(cases.id, unsourcedIds));
    const companyIds = [...new Set(records.map(row => row.companyId))];
    const companyDecisions = await access.decideReads(actor, companyIds.map(companyId => ({ type: "company" as const, companyId })));
    const allowedCompanies = new Set(companyIds.filter((_, index) => companyDecisions[index]?.allowed));
    for (const record of records) if (!allowedCompanies.has(record.companyId)) denied.add(record.id);
  }
  return rows.filter(row => !denied.has(row.id));
}

export async function assertActorCanReadCase(db: CaseDb, actor: AuthorizationActor, caseId: string | CaseIdentity) {
  if (!(await canActorReadCase(db, actor, caseId))) throw notFound("Case not found");
}

export async function retainCaseAccessSource(db: CaseDb, input: {
  companyId: string; caseId: string; sourceKind: "issue" | "project"; sourceId: string;
}) {
  const table = input.sourceKind === "issue" ? issues : projects;
  const [source] = await db.select({ id: table.id }).from(table)
    .where(and(eq(table.id, input.sourceId), eq(table.companyId, input.companyId))).limit(1);
  const [caseRow] = await db.select({ id: cases.id }).from(cases)
    .where(and(eq(cases.id, input.caseId), eq(cases.companyId, input.companyId))).limit(1);
  if (!source || !caseRow) throw notFound("Case access source not found");
  await db.insert(caseAccessSources).values(input).onConflictDoNothing();
}

/** Persist the authenticated run's task boundary before copying its output. */
export async function retainCaseRunSource(db: CaseDb, input: {
  companyId: string; caseId: string; runId?: string | null; agentId?: string | null;
}) {
  if (!input.runId || !isUuidLike(input.runId)) return false;
  const [run] = await db.select({ issueId: heartbeatRuns.issueId, agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).limit(1);
  if (!run || (input.agentId && run.agentId !== input.agentId) || !run.issueId) return false;
  await retainCaseAccessSource(db, { companyId: input.companyId, caseId: input.caseId, sourceKind: "issue", sourceId: run.issueId });
  return true;
}

/** The assignee grant is prospective only for the exact primary task. Other retained sources never gain grants. */
export async function canActorReceiveCase(db: CaseDb, actor: AuthorizationActor, caseRow: CaseIdentity, issueId: string, toAgentId: string) {
  const [recipient] = await db.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.id, toAgentId), eq(agents.companyId, caseRow.companyId))).limit(1);
  if (!recipient) return false;
  const [issue] = await db.select().from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, caseRow.companyId))).limit(1);
  if (!issue) return false;
  const recipientActor: AuthorizationActor = {
    type: "agent", agentId: toAgentId, companyId: caseRow.companyId,
    onBehalfOfUserId: issue.responsibleUserId ?? actor.onBehalfOfUserId,
    authorizingUserId: actor.authorizingUserId,
  };
  const sources = await db.select().from(caseAccessSources)
    .where(and(eq(caseAccessSources.caseId, caseRow.id), eq(caseAccessSources.companyId, caseRow.companyId)));
  const access = authorizationService(db);
  for (const source of sources) {
    if (source.sourceKind === "issue" && source.sourceId === issueId) {
      const currentDecision = await access.decide({ actor: recipientActor, action: "issue:read", resource: {
        type: "issue", companyId: caseRow.companyId, issueId,
      } });
      if (!currentDecision.allowed && currentDecision.reason !== "deny_issue_private") return false;
      // Canonical task privacy grants the new assignee access. Its responsible user
      // and pinned authorizer must still independently qualify for the same task.
      for (const userId of [...new Set([recipientActor.onBehalfOfUserId, recipientActor.authorizingUserId].filter((id): id is string => !!id))]) {
        const [member] = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
          eq(companyMemberships.companyId, caseRow.companyId), eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"),
        )).limit(1);
        if (!member || !(await access.decide({ actor: { type: "board", userId, ignoreInstanceAdmin: true }, action: "issue:read",
          resource: { type: "issue", companyId: caseRow.companyId, issueId } })).allowed) return false;
      }
      continue;
    }
    const sourceTable = source.sourceKind === "issue" ? issues : projects;
    const [retained] = await db.select({ id: sourceTable.id }).from(sourceTable).where(and(
      eq(sourceTable.id, source.sourceId), eq(sourceTable.companyId, caseRow.companyId),
    )).limit(1);
    if (!retained) return false;
    const decision = await access.decide({ actor: recipientActor,
      action: source.sourceKind === "issue" ? "issue:read" : "project:read",
      resource: source.sourceKind === "issue"
        ? { type: "issue", companyId: caseRow.companyId, issueId: source.sourceId }
        : { type: "project", companyId: caseRow.companyId, projectId: source.sourceId },
    });
    if (!decision.allowed) return false;
  }
  return true;
}
