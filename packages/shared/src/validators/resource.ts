import { z } from "zod";

export const resourceTypeSchema = z.literal("git");
export const resourceStatusSchema = z.enum(["active", "archived"]);
export const resourceAttachmentModeSchema = z.enum(["input", "output", "input_output"]);
export const resourceOutputActionSchema = z.enum(["none", "push", "pull_request"]);

const resourceKeySchema = z.string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Resource key must contain only letters, numbers, '.', '_' or '-'.")
  .refine((value) => !value.includes("..") && !value.endsWith(".") && !value.endsWith(".lock"), {
    message: "Resource key must produce a valid Git branch name.",
  });

const mountPathSchema = z.string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !value.startsWith("/") && value !== "." && value !== ".." && !value.startsWith("./") && !value.startsWith(".\\") && !value.split(/[\\/]/).includes(".."), {
    message: "Mount path must be normalized, relative, and cannot contain '..'.",
  });

const sourcePathSchema = z.string()
  .trim()
  .min(1)
  .max(2_000)
  .refine((value) => !value.startsWith("/") && !value.split(/[\\/]/).includes(".."), {
    message: "Source path must be relative and cannot contain '..'.",
  });

const repositorySchema = z.string()
  .trim()
  .min(1)
  .max(2_000)
  .refine((value) => {
    if (value === "." || value.startsWith("./") || value.startsWith(".\\") || value.startsWith("/")) {
      return !value.split(/[\\/]/).includes("..");
    }
    if (!/^(?:https:\/\/|ssh:\/\/git@|git@[^:]+:)/i.test(value)) return false;
    if (!/^https:\/\//i.test(value)) return true;
    try {
      const url = new URL(value);
      return !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Repository must use a supported HTTPS, SSH, Git transport, or safe local path.");

export const createResourceSchema = z.object({
  key: resourceKeySchema,
  type: resourceTypeSchema.default("git"),
  repository: repositorySchema,
  sourcePath: sourcePathSchema.nullable().optional(),
  defaultRef: z.string().trim().min(1).max(255).default("main"),
  mountPath: mountPathSchema,
  credentialRef: z.string().uuid().nullable().optional(),
  labels: z.record(z.string().trim().min(1).max(100), z.string().trim().max(500)).default({}),
});
export type CreateResource = z.infer<typeof createResourceSchema>;

export const updateResourceSchema = createResourceSchema.partial().extend({
  status: resourceStatusSchema.optional(),
});
export type UpdateResource = z.infer<typeof updateResourceSchema>;

export const resourceManifestAttachmentSchema = z.object({
  resourceId: z.string().uuid(),
  mode: resourceAttachmentModeSchema.default("input"),
  version: z.string().trim().min(1).max(255).optional(),
  output: z.object({
    action: resourceOutputActionSchema.default("none"),
    targetRef: z.string().trim().min(1).max(255).optional(),
    branch: z.string().trim().min(1).max(255).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    body: z.string().max(20_000).optional(),
  }).optional(),
});

export const resourceRunOverrideSchema = z.object({
  resourceId: z.string().uuid(),
  version: z.string().trim().min(1).max(255).optional(),
});
export const resourceRunOverridesSchema = z.array(resourceRunOverrideSchema).max(50).superRefine((overrides, ctx) => {
  const ids = new Set<string>();
  for (const [index, override] of overrides.entries()) {
    if (ids.has(override.resourceId)) {
      ctx.addIssue({ code: "custom", path: [index, "resourceId"], message: "Resource override may only appear once." });
    }
    ids.add(override.resourceId);
  }
});
export type ResourceRunOverrideInput = z.infer<typeof resourceRunOverrideSchema>;

export const workflowResourceManifestSchema = z.object({
  version: z.literal(1),
  resources: z.array(resourceManifestAttachmentSchema).max(50),
}).superRefine((manifest, ctx) => {
  const ids = new Set<string>();
  for (const [index, attachment] of manifest.resources.entries()) {
    if (ids.has(attachment.resourceId)) {
      ctx.addIssue({ code: "custom", path: ["resources", index, "resourceId"], message: "Resource may only be attached once." });
    }
    ids.add(attachment.resourceId);
  }
});
export type WorkflowResourceManifestInput = z.infer<typeof workflowResourceManifestSchema>;
