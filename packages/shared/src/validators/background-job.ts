import { z } from "zod";
import {
  BACKGROUND_JOB_BACKEND_KINDS,
  BACKGROUND_JOB_EVENT_LEVELS,
  BACKGROUND_JOB_EVENT_TYPES,
  BACKGROUND_JOB_RUN_STATUSES,
  BACKGROUND_JOB_RUN_TRIGGERS,
  BACKGROUND_JOB_STATUSES,
} from "../constants.js";

export const createBackgroundJobSchema = z
  .object({
    key: z.string().trim().min(1).max(128).regex(/^[a-z0-9][a-z0-9_.:-]*$/),
    jobType: z.string().trim().min(1).max(128),
    displayName: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    backendKind: z.enum(BACKGROUND_JOB_BACKEND_KINDS).optional().default("server_worker"),
    status: z.enum(BACKGROUND_JOB_STATUSES).optional().default("active"),
    config: z.record(z.unknown()).optional().default({}),
    sourceIssueId: z.string().uuid().nullable().optional(),
    sourceProjectId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const listBackgroundJobsQuerySchema = z
  .object({
    jobType: z.string().trim().min(1).max(128).optional(),
    status: z.enum(BACKGROUND_JOB_STATUSES).optional(),
    limit: z.coerce.number().int().positive().max(200).optional().default(50),
  })
  .strict();

export const createBackgroundJobRunSchema = z
  .object({
    jobId: z.string().uuid().nullable().optional(),
    jobKey: z.string().trim().min(1).max(128).optional(),
    jobType: z.string().trim().min(1).max(128).optional(),
    trigger: z.enum(BACKGROUND_JOB_RUN_TRIGGERS).optional().default("manual"),
    sourceIssueId: z.string().uuid().nullable().optional(),
    sourceProjectId: z.string().uuid().nullable().optional(),
    sourceAgentId: z.string().uuid().nullable().optional(),
    heartbeatRunId: z.string().uuid().nullable().optional(),
    totalItems: z.number().int().nonnegative().nullable().optional(),
    config: z.record(z.unknown()).optional(),
  })
  .strict()
  .refine((value) => value.jobId || (value.jobKey && value.jobType), {
    message: "Provide jobId or both jobKey and jobType",
  });

export const updateBackgroundJobRunProgressSchema = z
  .object({
    totalItems: z.number().int().nonnegative().nullable().optional(),
    processedItems: z.number().int().nonnegative().optional(),
    succeededItems: z.number().int().nonnegative().optional(),
    failedItems: z.number().int().nonnegative().optional(),
    skippedItems: z.number().int().nonnegative().optional(),
    progressPercent: z.number().min(0).max(100).nullable().optional(),
    currentItem: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export const createBackgroundJobEventSchema = z
  .object({
    eventType: z.enum(BACKGROUND_JOB_EVENT_TYPES),
    level: z.enum(BACKGROUND_JOB_EVENT_LEVELS).optional().default("info"),
    message: z.string().trim().max(4000).nullable().optional(),
    progressPercent: z.number().min(0).max(100).nullable().optional(),
    totalItems: z.number().int().nonnegative().nullable().optional(),
    processedItems: z.number().int().nonnegative().nullable().optional(),
    succeededItems: z.number().int().nonnegative().nullable().optional(),
    failedItems: z.number().int().nonnegative().nullable().optional(),
    skippedItems: z.number().int().nonnegative().nullable().optional(),
    currentItem: z.string().trim().max(500).nullable().optional(),
    details: z.record(z.unknown()).nullable().optional(),
  })
  .strict();

export const completeBackgroundJobRunSchema = z
  .object({
    status: z.enum(["succeeded", "failed", "cancelled"]),
    error: z.string().trim().max(4000).nullable().optional(),
    result: z.record(z.unknown()).nullable().optional(),
  })
  .strict();

export const listBackgroundJobRunsQuerySchema = z
  .object({
    jobId: z.string().uuid().optional(),
    jobType: z.string().trim().min(1).max(128).optional(),
    status: z.enum(BACKGROUND_JOB_RUN_STATUSES).optional(),
    sourceIssueId: z.string().uuid().optional(),
    sourceProjectId: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().max(200).optional().default(50),
  })
  .strict();

export type CreateBackgroundJob = z.infer<typeof createBackgroundJobSchema>;
export type ListBackgroundJobsQuery = z.infer<typeof listBackgroundJobsQuerySchema>;
export type CreateBackgroundJobRun = z.infer<typeof createBackgroundJobRunSchema>;
export type UpdateBackgroundJobRunProgress = z.infer<typeof updateBackgroundJobRunProgressSchema>;
export type CreateBackgroundJobEvent = z.infer<typeof createBackgroundJobEventSchema>;
export type CompleteBackgroundJobRun = z.infer<typeof completeBackgroundJobRunSchema>;
export type ListBackgroundJobRunsQuery = z.infer<typeof listBackgroundJobRunsQuerySchema>;
