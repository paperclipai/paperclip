import { z } from "zod";
import {
  ADAPTER_READINESS_REASON_CODES,
  ADAPTER_READINESS_STATUSES,
  LOCAL_ADAPTER_ASSURANCE_TYPES,
} from "../constants.js";

export const adapterReadinessStatusSchema = z.enum(ADAPTER_READINESS_STATUSES);
export const adapterReadinessReasonCodeSchema = z.enum(ADAPTER_READINESS_REASON_CODES);
export const localAdapterAssuranceTypeSchema = z.enum(LOCAL_ADAPTER_ASSURANCE_TYPES);

export const adapterReadinessProbeRequestSchema = z.object({
  adapterType: localAdapterAssuranceTypeSchema,
  strictMode: z.boolean().optional(),
});

export const adapterFallbackRecommendationSchema = z.object({
  adapterType: localAdapterAssuranceTypeSchema,
  label: z.string().min(1),
  reason: z.string().min(1),
  requiresApproval: z.literal(true),
});

export const adapterReadinessProbeSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  adapterType: localAdapterAssuranceTypeSchema,
  status: adapterReadinessStatusSchema,
  basicReady: z.boolean(),
  operationalReady: z.boolean(),
  fixtureReady: z.boolean(),
  reasonCodes: z.array(adapterReadinessReasonCodeSchema),
  cliVersion: z.string().nullable(),
  authMode: z.string().nullable(),
  model: z.string().nullable(),
  modelProfile: z.string().nullable(),
  workspaceStatus: z.string().nullable(),
  quotaWindows: z.record(z.string(), z.unknown()).nullable(),
  helloRunStatus: z.string().nullable(),
  helloRunMetadata: z.record(z.string(), z.unknown()).nullable(),
  heartbeatRunId: z.string().uuid().nullable(),
  fallbackRecommendation: adapterFallbackRecommendationSchema.nullable(),
  strictMode: z.boolean(),
  checkedByUserId: z.string().uuid().nullable(),
  checkedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
