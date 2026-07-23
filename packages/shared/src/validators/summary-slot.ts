import { z } from "zod";
import {
  SUMMARY_SLOT_KEYS,
  SUMMARY_SLOT_SCOPE_KINDS,
  SUMMARY_SLOT_STATUSES,
} from "../constants.js";

const optionalScopeIdSchema = z.string().uuid().optional().nullable();

export const summarySlotScopeKindSchema = z.enum(SUMMARY_SLOT_SCOPE_KINDS);
export const summarySlotKeySchema = z.enum(SUMMARY_SLOT_KEYS);
export const summarySlotStatusSchema = z.enum(SUMMARY_SLOT_STATUSES);

export const summarySlotScopeSelectorSchema = z
  .object({
    scopeKind: summarySlotScopeKindSchema,
    scopeId: optionalScopeIdSchema,
    slotKey: summarySlotKeySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasScopeId = typeof value.scopeId === "string";
    if (value.scopeKind === "workspaces_overview") {
      if (hasScopeId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "workspaces_overview summary slots must not include scopeId",
          path: ["scopeId"],
        });
      }
      return;
    }
    if (!hasScopeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.scopeKind} summary slots require scopeId`,
        path: ["scopeId"],
      });
    }
  });

export const summarySlotQuerySchema = z
  .object({
    scopeId: optionalScopeIdSchema,
  })
  .strict();

export const generateSummarySlotSchema = summarySlotQuerySchema;

export const writeSummarySlotSchema = z
  .object({
    scopeId: optionalScopeIdSchema,
    markdown: z.string().trim().min(1).max(200_000),
    title: z.string().trim().min(1).max(200).optional().nullable(),
    changeSummary: z.string().trim().min(1).max(1_000).optional().nullable(),
    baseRevisionId: z.string().uuid().optional().nullable(),
    generationIssueId: z.string().uuid().optional().nullable(),
    model: z.string().trim().min(1).max(200).optional().nullable(),
  })
  .strict();

export type SummarySlotScopeSelectorInput = z.infer<typeof summarySlotScopeSelectorSchema>;
export type GenerateSummarySlotInput = z.infer<typeof generateSummarySlotSchema>;
export type WriteSummarySlotInput = z.infer<typeof writeSummarySlotSchema>;
