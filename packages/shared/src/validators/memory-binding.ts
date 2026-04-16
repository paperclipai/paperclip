import { z } from "zod";

// ── Memory Binding CRUD ──────────────────────────────────────────────

export const createMemoryBindingSchema = z.object({
  key: z.string().min(1).max(128),
  providerKey: z.string().min(1).max(128),
  pluginId: z.string().uuid().optional().nullable(),
  config: z.record(z.unknown()).optional(),
  capabilities: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

export type CreateMemoryBinding = z.infer<typeof createMemoryBindingSchema>;

export const updateMemoryBindingSchema = z.object({
  key: z.string().min(1).max(128).optional(),
  providerKey: z.string().min(1).max(128).optional(),
  pluginId: z.string().uuid().optional().nullable(),
  config: z.record(z.unknown()).optional(),
  capabilities: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

export type UpdateMemoryBinding = z.infer<typeof updateMemoryBindingSchema>;

// ── Binding Target CRUD ──────────────────────────────────────────────

export const createMemoryBindingTargetSchema = z.object({
  targetType: z.enum(["company", "agent"]),
  targetId: z.string().uuid(),
  priority: z.number().int().optional(),
});

export type CreateMemoryBindingTarget = z.infer<typeof createMemoryBindingTargetSchema>;

// ── Memory Operations ──────────────────────────────────────────────

const memoryScopeSchema = z.object({
  companyId: z.string().uuid(),
  agentId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  issueId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
});

const memorySourceRefSchema = z.object({
  kind: z.enum([
    "issue_comment",
    "issue_document",
    "issue",
    "run",
    "activity",
    "manual_note",
    "external_document",
  ]),
  companyId: z.string().uuid(),
  issueId: z.string().uuid().optional(),
  commentId: z.string().uuid().optional(),
  documentKey: z.string().optional(),
  runId: z.string().uuid().optional(),
  activityId: z.string().uuid().optional(),
  externalRef: z.string().optional(),
});

const memoryRecordHandleSchema = z.object({
  providerKey: z.string().min(1).max(128),
  providerRecordId: z.string().min(1),
});

export const memoryWriteSchema = z.object({
  scope: memoryScopeSchema,
  source: memorySourceRefSchema,
  content: z.string().min(1).max(100_000),
  metadata: z.record(z.unknown()).optional(),
  mode: z.enum(["append", "upsert", "summarize"]).optional(),
});

export type MemoryWrite = z.infer<typeof memoryWriteSchema>;

export const memoryQuerySchema = z.object({
  scope: memoryScopeSchema,
  query: z.string().min(1).max(10_000),
  topK: z.number().int().positive().max(100).optional(),
  intent: z.enum(["agent_preamble", "answer", "browse"]).optional(),
  metadataFilter: z.record(z.unknown()).optional(),
});

export type MemoryQuery = z.infer<typeof memoryQuerySchema>;

export const memoryForgetSchema = z.object({
  scope: memoryScopeSchema,
  handles: z.array(memoryRecordHandleSchema).min(1).max(100),
});

export type MemoryForget = z.infer<typeof memoryForgetSchema>;
