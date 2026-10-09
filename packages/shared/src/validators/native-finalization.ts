import { z } from "zod";
import { NATIVE_FINALIZATION_SCHEMA } from "../types/native-finalization.js";

export const nativeFinalizationResultV1Schema = z.object({
  schema: z.literal(NATIVE_FINALIZATION_SCHEMA),
  runtimeMode: z.literal("native"),
  runId: z.string().uuid(),
  issueId: z.string().uuid(),
  companyId: z.string().uuid(),
  result: z.record(z.string(), z.unknown()),
  terminal: z.object({
    schema: z.literal("paperclip.prp.terminal.v1"),
    turnTerminalState: z.enum(["completed", "failed", "interrupted", "cancelled"]),
    runTerminalState: z.enum(["succeeded", "failed", "cancelled"]),
    reportedWorkDisposition: z.enum(["done", "blocked", "needs_review", "yielded"]),
  }).strict(),
  turnId: z.string().min(1).nullable(),
  sourceInstanceId: z.string().min(1).max(160),
  normalizedSessionId: z.string().min(1),
  providerSessionId: z.string().min(1).nullable(),
  driverKind: z.string().min(1),
  driverVersion: z.string().min(1),
  nativeEventCount: z.number().int().nonnegative(),
  highestContiguousSourceSeq: z.number().int().nonnegative(),
  workspaceFinalizeStatus: z.enum(["pending", "succeeded", "failed"]),
}).strict();

export const nativeReportedWorkDispositionSchema = z.enum([
  "done",
  "blocked",
  "needs_review",
  "yielded",
]);
export const nativeFinalizationResultSchema = nativeFinalizationResultV1Schema;
export type NativeFinalizationResultInput = z.infer<typeof nativeFinalizationResultSchema>;
