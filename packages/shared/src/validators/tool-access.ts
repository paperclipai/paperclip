import { z } from "zod";

export const companyToolSourceSchema = z.enum(["paperclip_builtin", "adapter_toolset", "mcp_tool", "skill"]);
export const companyToolRiskSchema = z.enum(["read", "write", "admin", "secret"]);
export const toolAccessModeSchema = z.enum(["off", "read", "write", "admin"]);

function requireOffMode(value: { supportedModes?: string[] }, ctx: z.RefinementCtx) {
  if (value.supportedModes && !value.supportedModes.includes("off")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "supportedModes must include off",
      path: ["supportedModes"],
    });
  }
}

const companyToolBaseSchema = z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string().trim().optional().nullable(),
  source: companyToolSourceSchema,
  adapter: z.string().trim().min(1),
  serverKey: z.string().trim().min(1).optional().nullable(),
  toolName: z.string().trim().min(1).optional().nullable(),
  risk: companyToolRiskSchema.default("read"),
  supportedModes: z.array(toolAccessModeSchema).min(1).default(["off", "read"]),
  render: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const companyToolCreateSchema = companyToolBaseSchema.superRefine(requireOffMode);

export const companyToolUpdateSchema = companyToolBaseSchema.partial().superRefine(requireOffMode);

export const agentToolGrantSetSchema = z.object({
  agentId: z.string().uuid(),
  toolId: z.string().uuid(),
  mode: toolAccessModeSchema,
});

export const agentToolGrantBulkSetSchema = z.object({
  grants: z.array(agentToolGrantSetSchema),
});

export const toolAccessPolicyUpdateSchema = z.object({
  approvalRequiredAtRisk: companyToolRiskSchema.optional().nullable(),
});

export const toolAccessPresetGrantSchema = z.object({
  toolKey: z.string().trim().min(1),
  mode: toolAccessModeSchema,
});

export const toolAccessPresetCreateSchema = z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1),
  grants: z.array(toolAccessPresetGrantSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const applyToolAccessPresetSchema = z.object({
  agentId: z.string().uuid(),
  presetId: z.string().uuid(),
});

export type CompanyToolCreate = z.infer<typeof companyToolCreateSchema>;
export type CompanyToolUpdate = z.infer<typeof companyToolUpdateSchema>;
export type AgentToolGrantSet = z.infer<typeof agentToolGrantSetSchema>;
export type AgentToolGrantBulkSet = z.infer<typeof agentToolGrantBulkSetSchema>;
export type ToolAccessPolicyUpdate = z.infer<typeof toolAccessPolicyUpdateSchema>;
export type ToolAccessPresetGrantInput = z.infer<typeof toolAccessPresetGrantSchema>;
export type ToolAccessPresetCreate = z.infer<typeof toolAccessPresetCreateSchema>;
export type ApplyToolAccessPreset = z.infer<typeof applyToolAccessPresetSchema>;
