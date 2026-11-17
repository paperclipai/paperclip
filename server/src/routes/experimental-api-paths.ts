// Experimental routes share their runtime validators with OpenAPI discovery.
import { z } from "zod";
import * as caseSchemas from "./cases-schemas.js";
import * as sharedSchemas from "@paperclipai/shared";

export const experimentalApiPaths: readonly [string, string, z.ZodTypeAny | undefined][] = [
  ["post", "/api/companies/{companyId}/cases", caseSchemas.createCaseSchema],
  ["get", "/api/companies/{companyId}/cases", undefined],
  ["get", "/api/companies/{companyId}/cases/types", undefined],
  ["get", "/api/cases/{id}/documents/{key}", undefined],
  ["get", "/api/cases/{id}/documents/{key}/annotations", undefined],
  ["get", "/api/cases/{id}/documents/{key}/annotations/{threadId}", undefined],
  ["post", "/api/cases/{id}/documents/{key}/annotations", sharedSchemas.createDocumentAnnotationThreadSchema],
  ["post", "/api/cases/{id}/documents/{key}/annotations/{threadId}/comments", sharedSchemas.createDocumentAnnotationCommentSchema],
  ["patch", "/api/cases/{id}/documents/{key}/annotations/{threadId}", sharedSchemas.updateDocumentAnnotationThreadSchema],
  ["put", "/api/cases/{id}/documents/{key}", caseSchemas.upsertCaseDocumentSchema],
  ["post", "/api/cases/{id}/documents/{key}/lock", undefined],
  ["post", "/api/cases/{id}/documents/{key}/unlock", undefined],
  ["post", "/api/cases/{id}/documents/{key}/revisions/{revisionId}/restore", undefined],
  ["delete", "/api/cases/{id}/documents/{key}", undefined],
  ["post", "/api/cases/{id}/links", caseSchemas.createIssueLinkSchema],
  ["post", "/api/cases/{id}/attachments", undefined],
  ["get", "/api/cases/{id}/events", undefined],
  ["get", "/api/cases/{id}/documents/{key}/revisions", undefined],
  ["get", "/api/issues/{issueId}/cases", undefined],
  ["get", "/api/cases/{id}", undefined],
  ["patch", "/api/cases/{id}", caseSchemas.patchCaseSchema],
  ["get", "/api/companies/{companyId}/smoke-lab/oauth/authorize", undefined],
  ["post", "/api/companies/{companyId}/smoke-lab/oauth/authorize", undefined],
  ["post", "/api/companies/{companyId}/smoke-lab/oauth/token", undefined],
  ["get", "/api/companies/{companyId}/smoke-lab/oauth/userinfo", undefined],
  ["post", "/api/companies/{companyId}/smoke-lab/oauth/revoke", undefined],
  ["get", "/api/companies/{companyId}/smoke-lab/services", undefined],
  ["post", "/api/companies/{companyId}/smoke-lab/services/start", undefined],
  ["post", "/api/companies/{companyId}/smoke-lab/services/stop", undefined],
  ["post", "/api/companies/{companyId}/smoke-lab/install-fixtures", undefined],
  ["get", "/api/companies/{companyId}/smoke-lab/runs", undefined],
  ["post", "/api/companies/{companyId}/smoke-lab/runs", sharedSchemas.createSmokeRunSchema],
  ["get", "/api/companies/{companyId}/smoke-lab/runs/{runId}", undefined],
  ["patch", "/api/companies/{companyId}/smoke-lab/runs/{runId}", sharedSchemas.updateSmokeRunSchema],
  ["post", "/api/companies/{companyId}/smoke-lab/runs/{runId}/steps", sharedSchemas.recordSmokeRunStepSchema],
  ["post", "/api/companies/{companyId}/smoke-lab/reset", undefined],
];

// Searchable summaries for experimental reads agents need to find. Routes not
// listed here keep the generated method-and-path summary.
export const experimentalApiDocs: Record<string, { summary: string; description: string }> = {
  "GET /api/companies/{companyId}/cases": { summary: "List company cases",
    description: "Lists the cases the caller can read, with each case's id, identifier, title, status and primary task (workIssueId)." },
  "GET /api/issues/{issueId}/cases": { summary: "Find the cases for a task",
    description: "Accepts a task UUID or identifier and returns each readable case linked to that task, as { id, role, case: { id, identifier, ... } }. The top-level id is the link; pass case.id to read_case or the case audit history." },
  "GET /api/cases/{id}": { summary: "Read a case and its current facts",
    description: "Returns the case identifier, title, status, current facts (fields) and primary task." },
  "PATCH /api/cases/{id}": { summary: "Update a case's facts, labels or status",
    description: "Updates title, summary, fields, labels, project, parent case or status. For a case with a primary task, agents do not close it here: the agent assigned to that task records a terminal handoff to done, and only that agent may cancel or reopen the case." },
  "GET /api/cases/{id}/events": { summary: "Read a case's audit history of fact changes, handoffs and links",
    description: "Newest first. Each event has its kind (such as fields_changed, status_changed, issue_linked), the actor and time. An agent actor has actorAgentId and actorAgentName; a person has actorType user and actorUserId, without a display name. A fields_changed event records who changed the facts and when; it does not retain the previous fact values. Document edits are in document revisions and handoffs in the case handoff history." },
  "GET /api/cases/{id}/documents/{key}/revisions": { summary: "Read a case document's revision history",
    description: "Returns every revision of a case-owned document, newest first, with body, author and time. An agent author has actorAgentName; a person has createdByUserId, without a display name." },
};

// Query contracts shared with the runtime parser where one exists.
export const experimentalApiQueries: Record<string, z.ZodObject<any>> = {
  "GET /api/companies/{companyId}/cases": caseSchemas.listCasesQuerySchema,
  "GET /api/cases/{id}/events": caseSchemas.listEventsQuerySchema,
  "GET /api/cases/{id}": caseSchemas.caseDetailQuerySchema,
  "PATCH /api/cases/{id}": caseSchemas.caseDetailQuerySchema,
};
