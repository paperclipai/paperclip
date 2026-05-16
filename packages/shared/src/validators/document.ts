import { z } from "zod";
import {
  issueDocumentFormatSchema,
  issueDocumentKeySchema,
  restoreIssueDocumentRevisionSchema,
  upsertIssueDocumentSchema,
} from "./issue.js";

// Document-level aliases. The existing issue-document schemas are re-exported
// under shorter names so company-root documents can share the same key/format/
// upsert validation surface without duplicating field rules.
export const documentKeySchema = issueDocumentKeySchema;
export const documentFormatSchema = issueDocumentFormatSchema;
export const upsertCompanyDocumentSchema = upsertIssueDocumentSchema;
export const restoreCompanyDocumentRevisionSchema = restoreIssueDocumentRevisionSchema;

export type DocumentKey = z.infer<typeof documentKeySchema>;
export type UpsertCompanyDocument = z.infer<typeof upsertCompanyDocumentSchema>;
export type RestoreCompanyDocumentRevision = z.infer<typeof restoreCompanyDocumentRevisionSchema>;
