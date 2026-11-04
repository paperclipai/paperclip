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

// Query contracts shared with the runtime parser where one exists.
export const experimentalApiQueries: Record<string, z.ZodObject<any>> = {
  "GET /api/companies/{companyId}/cases": caseSchemas.listCasesQuerySchema,
  "GET /api/cases/{id}/events": caseSchemas.listEventsQuerySchema,
  "GET /api/cases/{id}": caseSchemas.caseDetailQuerySchema,
  "PATCH /api/cases/{id}": caseSchemas.caseDetailQuerySchema,
};
