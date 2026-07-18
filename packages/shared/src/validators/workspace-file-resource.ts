import { z } from "zod";

const workspaceFileListSearchMaxBytes = 128;

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

export const workspaceFileWorkspaceKindSchema = z.enum(["execution_workspace", "project_workspace"]);
export const workspaceFileSelectorSchema = z.enum(["auto", "execution", "project"]).default("auto");
export const workspaceFileListModeSchema = z.enum(["all", "recent", "changed"]).default("all");
export const workspaceFilePreviewKindSchema = z.enum(["text", "image", "video", "pdf", "unsupported"]);
export const workspaceFileResourceKindSchema = z.enum(["file", "directory", "remote_resource"]);

export const workspaceFileRefSchema = z.object({
  kind: z.literal("workspace_file"),
  issueId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  projectName: z.string().min(1).optional(),
  workspaceKind: workspaceFileWorkspaceKindSchema,
  workspaceId: z.string().uuid(),
  relativePath: z.string().min(1),
  line: z.number().int().positive().nullable().optional(),
  column: z.number().int().positive().nullable().optional(),
  displayPath: z.string().min(1),
});

export const workspaceFileResourceQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  path: z
    .string()
    .min(1)
    .refine((value) => !/[\x00-\x1f\x7f]/.test(value), {
      message: "Workspace file path contains an invalid character",
      params: { code: "invalid_path" },
    }),
  workspace: workspaceFileSelectorSchema.optional(),
}).refine((value) => Boolean(value.projectId) === Boolean(value.workspaceId), {
  message: "Workspace file target requires both projectId and workspaceId",
  path: ["workspaceId"],
  params: { code: "invalid_target" },
});

export const workspaceFileListQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  workspace: workspaceFileSelectorSchema.optional(),
  path: z
    .string()
    .min(1)
    .refine((value) => !/[\x00-\x1f\x7f]/.test(value), {
      message: "Workspace folder path contains an invalid character",
      params: { code: "invalid_path" },
    })
    .optional(),
  mode: workspaceFileListModeSchema.optional(),
  q: z
    .string()
    .refine((value) => !/[\x00-\x1f\x7f]/.test(value), {
      message: "Workspace file search contains an invalid character",
      params: { code: "invalid_query" },
    })
    .refine((value) => utf8ByteLength(value.trim()) <= workspaceFileListSearchMaxBytes, {
      message: "Workspace file search is too long",
      params: { code: "invalid_query" },
    })
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
}).refine((value) => Boolean(value.projectId) === Boolean(value.workspaceId), {
  message: "Workspace file target requires both projectId and workspaceId",
  path: ["workspaceId"],
  params: { code: "invalid_target" },
});

export const resolvedWorkspaceResourceSchema = z.object({
  kind: workspaceFileResourceKindSchema,
  provider: z.string().min(1),
  title: z.string().min(1),
  displayPath: z.string().min(1),
  workspaceLabel: z.string().min(1),
  workspaceKind: workspaceFileWorkspaceKindSchema,
  workspaceId: z.string().uuid(),
  projectId: z.string().uuid().nullable().optional(),
  projectName: z.string().min(1).nullable().optional(),
  contentType: z.string().nullable().optional(),
  byteSize: z.number().int().nonnegative().nullable().optional(),
  previewKind: workspaceFilePreviewKindSchema,
  denialReason: z.string().nullable().optional(),
  capabilities: z.object({
    preview: z.boolean(),
    download: z.boolean(),
    listChildren: z.boolean(),
  }),
});

export const workspaceFileContentSchema = z.object({
  resource: resolvedWorkspaceResourceSchema,
  content: z.object({
    encoding: z.enum(["utf8", "base64"]),
    data: z.string(),
  }),
});

export type WorkspaceFileResourceQuery = z.infer<typeof workspaceFileResourceQuerySchema>;
export type WorkspaceFileListQuery = z.infer<typeof workspaceFileListQuerySchema>;
