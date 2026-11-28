import { CASE_STATUSES, type CaseDetail, type CaseEvent, type CaseHandoffView } from "@/api/cases";
import { instanceExperimentalSettingsSchema } from "@paperclipai/shared";
import { storybookAgents, storybookProjects } from "../fixtures/paperclipData";
import { caseActors, readonlyCaseFixtures, type CaseRecord } from "./cases-read-only-fixtures";
import { prepareFixtureApi, type FixtureState } from "./capability-gaps/api";

const companyId = "company-storybook";
const projectId = (name: string | null) => name === "Paperclip" ? "project-cases-paperclip" : name === "Website" ? "project-cases-website" : null;
const caseId = (record: CaseRecord) => `case-${record.identifier}`;
const taskId = (record: CaseRecord) => record.task ? `task-${record.task.identifier}` : null;
const actor = (role: string) => caseActors[role];

export function caseFixtureHandoffs(record: CaseRecord): CaseHandoffView[] {
  return record.handoffs.map((handoff, index) => ({
    id: handoff.id, companyId, caseId: caseId(record), issueId: taskId(record)!,
    version: record.handoffs.length - index, destinationKind: "agent", completedAt: null, workflowTransition: null,
    fromAgentId: actor(handoff.from)?.kind === "agent" ? actor(handoff.from).id : null,
    fromAgentName: actor(handoff.from)?.kind === "agent" ? actor(handoff.from).name : null,
    toAgentId: actor(handoff.to).id, toAgentName: actor(handoff.to).name,
    phase: handoff.phase, instructions: handoff.instructions, commentId: null,
    actorType: actor(handoff.from)?.kind ?? "user", actorId: actor(handoff.from)?.id ?? "user-dotta",
    sourceRunId: null, responsibleUserId: "user-dotta",
    expectedIssueStatusVersion: 1, appliedIssueStatusVersion: handoff.state === "awaiting_release" ? null : 2,
    wakeupRequestId: `wake-${handoff.id}`, idempotencyKey: `storybook-${handoff.id}`, inputFingerprint: "fixture",
    state: handoff.state, attemptCount: 1, nextAttemptAt: handoff.at, leaseExpiresAt: null,
    lastErrorCode: handoff.waitingReason ? "agent_paused" : null, lastError: handoff.waitingReason ?? null,
    createdAt: handoff.at, assignmentAppliedAt: handoff.state === "awaiting_release" ? null : handoff.at,
    deliveredAt: handoff.state === "delivered" ? handoff.at : null, cancelledAt: null, updatedAt: handoff.at,
  }));
}

export function caseFixtureDetail(record: CaseRecord): CaseDetail {
  const handoffs = caseFixtureHandoffs(record);
  const task = record.task;
  const documentRefs = record.documents.map(document => ({
      key: document.key,
      document: {
        id: `doc-${record.identifier}-${document.key}`, companyId, title: document.title, format: "markdown",
        latestBody: document.body, latestRevisionId: `rev-${record.identifier}-${document.key}`,
        latestRevisionNumber: document.revision,
        createdByAgentId: null, createdByUserId: "user-dotta", updatedByAgentId: null, updatedByUserId: "user-dotta",
        lockedAt: null, lockedByAgentId: null, lockedByUserId: null, createdAt: record.createdAt, updatedAt: record.updatedAt,
      },
    }));
  return {
    id: caseId(record), companyId, projectId: projectId(record.project),
    caseNumber: Number(record.identifier.split("-C")[1]), identifier: record.identifier,
    caseType: record.type, key: null, title: record.title, summary: record.summary,
    status: record.status === "open" ? "draft" : record.status,
    fields: record.fields, workIssueId: taskId(record), phase: task?.phase ?? null,
    handoffVersion: handoffs.length, parentCaseId: null, createdByAgentId: null, createdByUserId: "user-dotta",
    completedAt: record.status === "done" ? record.updatedAt : null,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
    workIssue: task ? {
      id: taskId(record)!, identifier: task.identifier, title: task.title, status: task.status,
      statusVersion: 2, assigneeAgentId: actor(task.assignee).id, assigneeAgentName: actor(task.assignee).name,
    } : null,
    pendingHandoff: handoffs.find(handoff => handoff.state !== "delivered") ?? null,
    parent: null, labels: [], attachments: [],
    issueLinks: task ? [{
      id: `link-${record.identifier}`, caseId: caseId(record), issueId: taskId(record)!, role: "work",
      createdAt: record.createdAt,
      issue: { id: taskId(record)!, identifier: task.identifier, title: task.title, status: task.status },
    }] : [],
    documents: task ? [] : documentRefs,
    taskDocuments: task ? documentRefs.map(reference => {
      const { latestBody: _body, ...metadata } = reference.document;
      return {
        id: `issue:${taskId(record)}:${reference.key}`, sourceKind: "issue" as const,
        taskId: taskId(record)!, taskIdentifier: task.identifier, scope: "primary" as const,
        key: reference.key, document: metadata,
        readPath: `/api/issues/${taskId(record)}/documents/${encodeURIComponent(reference.key)}`,
      };
    }) : [],
    taskDocumentsOmitted: false,
  };
}

/** Real DTOs at the HTTP boundary; no duplicate page implementation. */
export function installReadOnlyCaseFixtures(state: FixtureState = "ready") {
  const details = readonlyCaseFixtures.map(caseFixtureDetail);
  let failFirstListRead = state === "failure";
  const listState = state === "failure" ? "ready" : state;
  const findCase = (value: string) => details.find(record => record.id === value || record.identifier === value);
  const projects = ["Paperclip", "Website"].map((name, index) => ({
    ...storybookProjects[index], id: projectId(name)!, companyId, name,
  }));
  const agents = Object.values(caseActors).filter(value => value.kind === "agent").map(value => ({
    ...storybookAgents.find(agent => agent.id === value.id) ?? storybookAgents[0],
    id: value.id, name: value.name, companyId,
    status: value.id === "agent-qa" ? "paused" : "idle",
  }));
  return prepareFixtureApi([
    { path: "/api/instance/settings/experimental", state: "ready", read: () => instanceExperimentalSettingsSchema.parse({ enableCases: true }) },
    { path: "/api/cli-auth/me", state: "ready", read: () => ({ source: "local_implicit", isInstanceAdmin: true, companyIds: [companyId], memberships: [] }) },
    { path: /\/resource-memberships\/me$/, state: "ready", read: () => ({ projectMemberships: {}, agentMemberships: {}, starredProjectIds: [], starredAgentIds: [], starredDocumentIds: [], projectStarredAt: {}, agentStarredAt: {}, documentStarredAt: {}, updatedAt: null }) },
    { path: /\/budgets\/overview$/, state: "ready", read: () => ({ policies: [], activeIncidents: [], pausedAgentCount: 0, pausedProjectCount: 0, pendingApprovalCount: 0 }) },
    { path: "/api/plugins/ui-contributions", state: "ready", read: () => [] },
    { path: `/api/companies/${companyId}/projects`, state: "ready", read: () => projects },
    { path: /^\/api\/projects\/project-cases-(paperclip|website)$/, state: "ready", read: ({ url }) => projects.find(project => project.id === url.pathname.split("/").at(-1)) },
    { path: `/api/companies/${companyId}/agents`, state: "ready", read: () => agents },
    { path: `/api/companies/${companyId}/cases/types`, state: "ready", read: () => state === "empty" ? [] : [...new Set(details.map(record => record.caseType))].sort() },
    { path: `/api/companies/${companyId}/cases`, state: listState, read: ({ url }) => {
      if (failFirstListRead) { failFirstListRead = false; return Response.json({ error: "Cases couldn’t be loaded." }, { status: 500 }); }
      if (state === "empty" || url.searchParams.has("parent")) return [];
      const query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
      return details.filter(record =>
        (!query || [record.identifier, record.title, record.summary, JSON.stringify(record.fields)].join(" ").toLowerCase().includes(query))
        && (!url.searchParams.has("status") || record.status === url.searchParams.get("status"))
        && (!url.searchParams.has("type") || record.caseType === url.searchParams.get("type"))
        && (!url.searchParams.has("projectId") || record.projectId === url.searchParams.get("projectId"))
        && (url.searchParams.get("includeNoProject") !== "true" || record.projectId === null)
      ).sort((left, right) => {
        const compare = (a: string | number, b: string | number) => a < b ? -1 : a > b ? 1 : 0;
        const group = url.searchParams.get("groupBy");
        const grouped = group === "status" ? compare(CASE_STATUSES.indexOf(left.status), CASE_STATUSES.indexOf(right.status))
          : group === "type" ? compare(left.caseType, right.caseType)
            : group === "project" ? left.projectId === null ? right.projectId === null ? 0 : 1
              : right.projectId === null ? -1 : compare(left.projectId, right.projectId) : 0;
        if (grouped) return grouped;
        const sortValue = (record: CaseDetail) => {
          switch (url.searchParams.get("sortField")) {
            case "title": return record.title.toLowerCase();
            case "created": return record.createdAt;
            case "status": return CASE_STATUSES.indexOf(record.status);
            case "type": return record.caseType;
            default: return record.updatedAt;
          }
        };
        return compare(sortValue(left), sortValue(right)) * (url.searchParams.get("sortDir") === "asc" ? 1 : -1)
          || compare(right.updatedAt, left.updatedAt) || compare(right.createdAt, left.createdAt) || compare(right.id, left.id);
      }).slice(Number(url.searchParams.get("offset") ?? 0), Number(url.searchParams.get("offset") ?? 0) + Number(url.searchParams.get("limit") ?? 200));
    } },
    { path: /^\/api\/cases\/([^/]+)$/, read: ({ url }) => findCase(decodeURIComponent(url.pathname.split("/").at(-1)!)) ?? Response.json({ error: "Not found" }, { status: 404 }) },
    { path: /^\/api\/cases\/([^/]+)\/handoffs$/, read: ({ url }) => {
      const value = url.pathname.split("/")[3];
      const record = readonlyCaseFixtures.find(item => caseId(item) === value || item.identifier === value);
      return { items: record ? caseFixtureHandoffs(record) : [], nextCursor: null, canControl: true };
    } },
    { path: /^\/api\/cases\/([^/]+)\/events$/, read: () => [] satisfies CaseEvent[] },
    { path: /^\/api\/issues\/([^/]+)\/documents\/([^/]+)(\/revisions)?$/, read: ({ url }) => {
      const [, , , id, , key] = url.pathname.split("/");
      const source = readonlyCaseFixtures.find(record => taskId(record) === decodeURIComponent(id));
      const saved = source?.documents.find(document => document.key === decodeURIComponent(key));
      const reference = details.find(record => record.workIssueId === id)?.taskDocuments?.find(document => document.key === decodeURIComponent(key));
      if (!saved || !reference) return Response.json({ error: "Not found" }, { status: 404 });
      if (url.pathname.endsWith("/revisions")) return [saved.revision, ...(saved.revision > 1 ? [saved.revision - 1] : [])].map(revisionNumber => ({
        id: revisionNumber === saved.revision ? reference.document.latestRevisionId : `previous-${reference.document.id}`,
        companyId, documentId: reference.document.id, issueId: reference.taskId, key: reference.key,
        revisionNumber, title: saved.title, format: "markdown",
        body: revisionNumber === saved.revision ? saved.body : "## Earlier draft\n\nThis document was saved before the current findings were completed.",
        createdAt: revisionNumber === saved.revision ? source!.updatedAt : source!.createdAt,
        createdByAgentId: null, createdByUserId: "user-dotta", changeSummary: revisionNumber === saved.revision ? "Saved findings" : "Initial draft",
      }));
      return { ...reference.document, issueId: reference.taskId, key: reference.key, body: saved.body };
    } },
    { path: /^\/api\/cases\/([^/]+)\/documents\/([^/]+)(\/revisions)?$/, read: ({ url }) => {
      const [, , , id, , key] = url.pathname.split("/");
      const record = findCase(decodeURIComponent(id));
      const reference = record?.documents.find(item => item.key === decodeURIComponent(key));
      if (!reference) return Response.json({ error: "Not found" }, { status: 404 });
      if (url.pathname.endsWith("/revisions")) return { key: reference.key, document: reference.document, revisions: [{
        id: reference.document.latestRevisionId, documentId: reference.document.id,
        revisionNumber: reference.document.latestRevisionNumber, title: reference.document.title,
        body: reference.document.latestBody, format: "markdown", createdAt: reference.document.updatedAt,
        createdByAgentId: null, createdByUserId: "user-dotta", changeSummary: "Saved findings",
        actorAgentName: null, issue: null, runId: null,
      }] };
      return { ...reference.document, key: reference.key, body: reference.document.latestBody };
    } },
  ]);
}
