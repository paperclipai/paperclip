import { z } from "zod";
import { issueDocumentFormatSchema } from "./issue.js";

export const createCompanyDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  format: issueDocumentFormatSchema,
  body: z.string().max(524288),
  changeSummary: z.string().trim().max(500).nullable().optional(),
});

export const updateCompanyDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  format: issueDocumentFormatSchema,
  body: z.string().max(524288),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
});

export const restoreCompanyDocumentRevisionSchema = z.object({});

export type CreateCompanyDocument = z.infer<typeof createCompanyDocumentSchema>;
export type UpdateCompanyDocument = z.infer<typeof updateCompanyDocumentSchema>;
export type RestoreCompanyDocumentRevision = z.infer<typeof restoreCompanyDocumentRevisionSchema>;
