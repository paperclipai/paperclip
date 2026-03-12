import { z } from "zod";

export const pluginLifecycleStateSchema = z.object({
  loadCount: z.number().int().nonnegative(),
  restartCount: z.number().int().nonnegative(),
  lastLoadedAt: z.string().datetime().optional(),
  lastInitializedAt: z.string().datetime().optional(),
  lastHealthAt: z.string().datetime().optional(),
  lastShutdownAt: z.string().datetime().optional(),
});

export const pluginRegistryRecordSchema = z.object({
  pluginId: z.string().min(1),
  packageName: z.string().min(1),
  packageVersion: z.string().min(1),
  sourcePath: z.string().min(1),
  symlinkPath: z.string().min(1),
  manifestPath: z.string().min(1),
  workerPath: z.string().min(1),
  enabled: z.boolean(),
  status: z.enum(["ready", "error", "disabled"]),
  config: z.record(z.string(), z.unknown()),
  lifecycle: pluginLifecycleStateSchema,
  installedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastError: z.string().optional(),
  lastHealth: z.unknown().optional(),
});

export const pluginListResponseSchema = z.object({
  plugins: z.array(pluginRegistryRecordSchema),
});

export const pluginActionResponseSchema = z.object({
  plugin: pluginRegistryRecordSchema,
});

export const pluginInstallBodySchema = z.object({
  path: z.string().min(1),
  skipBootstrap: z.boolean().optional(),
});

export const pluginToggleBodySchema = z.object({
  enabled: z.boolean(),
});

export const pluginRestartResultSchema = z.object({
  pluginId: z.string().min(1),
  status: z.enum(["ready", "error", "disabled"]),
  health: z.unknown().optional(),
  error: z.string().optional(),
});

export const pluginRestartResponseSchema = z.object({
  result: pluginRestartResultSchema,
  plugin: pluginRegistryRecordSchema,
});

export const pluginConfigFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  type: z.enum(["string", "number", "boolean", "textarea", "password", "select", "json"]),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  placeholder: z.string().optional(),
  options: z
    .array(
      z.object({
        label: z.string(),
        value: z.union([z.string(), z.number(), z.boolean()]),
      }),
    )
    .optional(),
});

export const pluginConfigSchemaSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  restartRequired: z.boolean().optional(),
  fields: z.array(pluginConfigFieldSchema),
});

export const pluginConfigDescribeResponseSchema = z.object({
  plugin: pluginRegistryRecordSchema,
  config: z.record(z.string(), z.unknown()),
  schema: pluginConfigSchemaSchema,
  schemaSource: z.enum(["manifest", "inferred"]),
});

export const pluginConfigUpdateBodySchema = z.object({
  config: z.record(z.string(), z.unknown()),
  restart: z.boolean().optional(),
});

export const pluginConfigUpdateResponseSchema = z.object({
  plugin: pluginRegistryRecordSchema,
  restartResult: pluginRestartResultSchema.optional(),
});

export type PluginLifecycleState = z.infer<typeof pluginLifecycleStateSchema>;
export type PluginRegistryRecord = z.infer<typeof pluginRegistryRecordSchema>;
export type PluginListResponse = z.infer<typeof pluginListResponseSchema>;
export type PluginActionResponse = z.infer<typeof pluginActionResponseSchema>;
export type PluginInstallBody = z.infer<typeof pluginInstallBodySchema>;
export type PluginToggleBody = z.infer<typeof pluginToggleBodySchema>;
export type PluginRestartResult = z.infer<typeof pluginRestartResultSchema>;
export type PluginRestartResponse = z.infer<typeof pluginRestartResponseSchema>;
export type PluginConfigField = z.infer<typeof pluginConfigFieldSchema>;
export type PluginConfigSchema = z.infer<typeof pluginConfigSchemaSchema>;
export type PluginConfigDescribeResponse = z.infer<typeof pluginConfigDescribeResponseSchema>;
export type PluginConfigUpdateBody = z.infer<typeof pluginConfigUpdateBodySchema>;
export type PluginConfigUpdateResponse = z.infer<typeof pluginConfigUpdateResponseSchema>;
