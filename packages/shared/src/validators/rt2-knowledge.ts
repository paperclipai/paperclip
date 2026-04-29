import { z } from "zod";

export const rt2WikiPageTypeSchema = z.enum(["index", "log", "topic"]);

export const listRt2WikiPagesSchema = z.object({
  pageType: rt2WikiPageTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const getRt2WikiPageSchema = z.object({
  pageKey: z.string().min(1).max(240),
});

export const listRt2DailyWikiPagesSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  userId: z.string().min(1).max(160).optional(),
  projectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const getRt2DailyWikiPageSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  userId: z.string().min(1).max(160).optional(),
});

export const rebuildRt2DailyWikiSchema = z.object({
  // No required fields — rebuilds all dates for the company
});

export const projectRt2KnowledgeSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

export const saveRt2KnowledgeVaultWriterSettingsSchema = z.object({
  vaultName: z.string().min(1).max(120).optional(),
  rootPath: z.string().min(1).max(400),
  exportSubdirectory: z.string().min(1).max(160).optional(),
  writerMode: z.enum(["dry_run", "local_path"]).optional(),
});

export const rt2LocalBridgeStatusSchema = z.enum(["paired", "available", "unavailable", "stale", "blocked", "conflict"]);
export const rt2LocalBridgeQueueOperationSchema = z.enum(["export", "import", "conflict_resolution"]);

export const createRt2LocalBridgePairingSchema = z.object({
  bridgeName: z.string().min(1).max(120).optional(),
  vaultName: z.string().min(1).max(120).optional(),
});

export const rt2LocalBridgeHeartbeatSchema = z.object({
  bridgeId: z.string().uuid(),
  pairingToken: z.string().min(16).max(240),
  status: rt2LocalBridgeStatusSchema.optional(),
  blockedReason: z.string().max(500).nullable().optional(),
  conflictCount: z.number().int().min(0).max(100_000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const createRt2LocalBridgeQueueSchema = z.object({
  operation: rt2LocalBridgeQueueOperationSchema,
  pageKey: z.string().min(1).max(240).optional(),
  vaultPath: z.string().min(1).max(400).optional(),
  candidateIds: z.array(z.string().min(1).max(240)).max(200).optional(),
  blockedReason: z.string().max(500).nullable().optional(),
});

export const applyRt2LocalBridgeQueueSchema = z.object({
  queueId: z.string().uuid(),
  status: z.enum(["applied", "blocked", "conflict", "failed"]).optional(),
  blockedReason: z.string().max(500).nullable().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
});

export const previewRt2KnowledgeVaultImportSchema = z.object({
  vaultName: z.string().min(1).max(120).optional(),
  projectId: z.string().uuid().optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(240),
        content: z.string().min(1).max(200_000),
      }),
    )
    .min(1)
    .max(50),
});

export const applyRt2KnowledgeVaultImportSchema = previewRt2KnowledgeVaultImportSchema.extend({
  approvedCandidateIds: z.array(z.string().min(1).max(240)).min(1).max(200),
  reason: z.string().max(500).optional(),
});

export const resolveRt2KnowledgeVaultConflictSchema = z.object({
  projectId: z.string().uuid().optional(),
  file: z.object({
    path: z.string().min(1).max(240),
    content: z.string().min(1).max(200_000),
  }),
  decision: z.enum(["rt2_wins", "vault_wins", "manual_merge"]),
  manualMarkdown: z.string().max(200_000).optional(),
  reason: z.string().min(1).max(500),
});

export const listRt2ContradictionCandidatesSchema = z.object({
  status: z.enum(["open", "resolved", "all"]).optional(),
  projectId: z.string().uuid().optional(),
});

export const generateRt2ContradictionCandidatesSchema = z.object({
  projectId: z.string().uuid(),
});

export const resolveRt2ContradictionSchema = z.object({
  decision: z.enum(["false_positive", "accept_newer", "keep_older", "request_follow_up"]),
  reason: z.string().min(1).max(500),
  followUpIssueId: z.string().uuid().nullable().optional(),
});

export type ListRt2WikiPages = z.infer<typeof listRt2WikiPagesSchema>;
export type GetRt2WikiPage = z.infer<typeof getRt2WikiPageSchema>;
export type ListRt2DailyWikiPages = z.infer<typeof listRt2DailyWikiPagesSchema>;
export type GetRt2DailyWikiPage = z.infer<typeof getRt2DailyWikiPageSchema>;
export type RebuildRt2DailyWiki = z.infer<typeof rebuildRt2DailyWikiSchema>;
export type ProjectRt2Knowledge = z.infer<typeof projectRt2KnowledgeSchema>;
export type SaveRt2KnowledgeVaultWriterSettings = z.infer<typeof saveRt2KnowledgeVaultWriterSettingsSchema>;
export type CreateRt2LocalBridgePairing = z.infer<typeof createRt2LocalBridgePairingSchema>;
export type Rt2LocalBridgeHeartbeat = z.infer<typeof rt2LocalBridgeHeartbeatSchema>;
export type CreateRt2LocalBridgeQueue = z.infer<typeof createRt2LocalBridgeQueueSchema>;
export type ApplyRt2LocalBridgeQueue = z.infer<typeof applyRt2LocalBridgeQueueSchema>;
export type PreviewRt2KnowledgeVaultImport = z.infer<typeof previewRt2KnowledgeVaultImportSchema>;
export type ApplyRt2KnowledgeVaultImport = z.infer<typeof applyRt2KnowledgeVaultImportSchema>;
export type ResolveRt2KnowledgeVaultConflict = z.infer<typeof resolveRt2KnowledgeVaultConflictSchema>;
export type ListRt2ContradictionCandidates = z.infer<typeof listRt2ContradictionCandidatesSchema>;
export type GenerateRt2ContradictionCandidates = z.infer<typeof generateRt2ContradictionCandidatesSchema>;
export type ResolveRt2Contradiction = z.infer<typeof resolveRt2ContradictionSchema>;
