import { z } from "zod";

/**
 * Query contract for GET /api/companies/:companyId/coordination/work.
 *
 * Strict on purpose: any query parameter outside this shape is rejected with
 * 400 instead of silently ignored, so a caller that misspells a filter cannot
 * mistake an unfiltered page for the filtered one.
 */
export const companyCoordinationWorkQuerySchema = z
  .object({
    projectId: z.string().guid().optional(),
    // Query params arrive as strings; a nonnegative decimal string is the only
    // accepted form. Parsed to an integer offset for the DB query.
    offset: z
      .string()
      .regex(/^\d+$/, "offset must be a non-negative integer")
      .transform((value) => Number.parseInt(value, 10))
      .optional()
      .default(0),
  })
  .strict();

export type CompanyCoordinationWorkQuery = z.infer<typeof companyCoordinationWorkQuerySchema>;

/**
 * Body contract for POST /api/companies/:companyId/coordination/handoffs.
 * Strict: unknown fields are rejected. The source issue id is always bound to
 * the caller's active run by the server; it is validated as a UUID here and
 * matched against the run binding in the service.
 */
export const coordinationHandoffBodySchema = z
  .object({
    sourceIssueId: z.string().guid(),
    targetIssueId: z.string().guid(),
    message: z.string().min(1).max(4000),
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();

export type CoordinationHandoffBody = z.infer<typeof coordinationHandoffBodySchema>;
