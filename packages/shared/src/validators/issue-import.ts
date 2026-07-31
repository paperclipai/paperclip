import { z } from "zod";

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const linearSourceUrlSchema = z.string().url().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "linear.app" || url.hostname.endsWith(".linear.app"));
  } catch {
    return false;
  }
}, "sourceUrl must be an HTTPS linear.app URL");

export const linearIssueImportCommentSchema = z.object({
  sourceCommentId: boundedText(255),
  sourceEventId: boundedText(255),
  sourceUpdatedAt: z.string().datetime({ offset: true }).optional().nullable(),
  body: z.string().max(100_000),
}).strict();

export const linearIssueImportItemSchema = z.object({
  sourceId: z.string().uuid(),
  sourceIdentifier: z.string().trim().regex(/^[A-Z][A-Z0-9]*-\d+$/).max(64),
  sourceVersion: boundedText(255),
  sourceUpdatedAt: z.string().datetime({ offset: true }),
  sourceUrl: linearSourceUrlSchema,
  title: boundedText(500),
  description: z.string().max(200_000).optional().nullable(),
  sourceStatus: boundedText(100),
  priority: z.enum(["critical", "high", "medium", "low"]),
  projectSourceId: boundedText(255).optional().nullable(),
  parentSourceId: z.string().uuid().optional().nullable(),
  blockedBySourceIds: z.array(z.string().uuid()).max(100).default([]),
  comments: z.array(linearIssueImportCommentSchema).max(50).default([]),
}).strict();

export const previewLinearIssueImportSchema = z.object({
  provider: z.literal("linear"),
  manifestVersion: z.number().int().positive().max(1000),
  sourceSnapshot: z.object({
    retrievedAt: z.string().datetime({ offset: true }),
    version: boundedText(255),
  }).strict(),
  options: z.object({
    stageUnassigned: z.literal(true),
    suppressWakes: z.literal(true),
    conflictPolicy: z.literal("record"),
  }).strict(),
  projectMappings: z.record(boundedText(255), z.string().uuid()),
  items: z.array(linearIssueImportItemSchema).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  if (Object.keys(value.projectMappings).length > 100) {
    ctx.addIssue({ code: "custom", path: ["projectMappings"], message: "At most 100 project mappings are allowed" });
  }
  const seenSources = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    if (seenSources.has(item.sourceId)) {
      ctx.addIssue({ code: "custom", path: ["items", index, "sourceId"], message: "Duplicate sourceId" });
    }
    seenSources.add(item.sourceId);
    const seenEvents = new Set<string>();
    for (const [commentIndex, comment] of item.comments.entries()) {
      const key = `${comment.sourceCommentId}\0${comment.sourceEventId}`;
      if (seenEvents.has(key)) {
        ctx.addIssue({ code: "custom", path: ["items", index, "comments", commentIndex], message: "Duplicate provider comment event" });
      }
      seenEvents.add(key);
    }
  }
});

export const applyLinearIssueImportSchema = z.object({
  previewRunId: z.string().uuid(),
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  activate: z.literal(false).default(false),
}).strict();

export type PreviewLinearIssueImport = z.infer<typeof previewLinearIssueImportSchema>;
export type LinearIssueImportItem = z.infer<typeof linearIssueImportItemSchema>;
export type ApplyLinearIssueImport = z.infer<typeof applyLinearIssueImportSchema>;
