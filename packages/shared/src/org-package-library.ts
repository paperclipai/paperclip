import { z } from "zod";

const packageKeySchema = z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9_-]*$/);
const permissionKeySchema = z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9_.:-]*$/);
const approvalGateSchema = z.enum(["none", "lead", "board", "compliance"]);

export const paperclipOrgPackageManifestSchema = z.object({
  version: z.literal(1),
  key: packageKeySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  provenance: z.object({
    author: z.string().trim().min(1).max(200),
    source: z.enum(["internal", "github", "local", "marketplace"]),
    sourceRef: z.string().trim().max(200).optional(),
    trustLevel: z.enum(["draft", "reviewed", "verified"]),
  }),
  skills: z
    .array(
      z.object({
        key: packageKeySchema,
        name: z.string().trim().min(1).max(200),
        version: z.string().trim().max(80).optional(),
      }),
    )
    .default([]),
  prompts: z
    .array(
      z.object({
        key: packageKeySchema,
        title: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(20000),
      }),
    )
    .default([]),
  mcpBundles: z
    .array(
      z.object({
        key: packageKeySchema,
        servers: z.array(
          z.object({
            catalogId: z.string().trim().min(1).max(240),
            permissionProfile: z.enum(["read_only", "paperclip_write", "external_live", "destructive"]),
          }),
        ),
      }),
    )
    .default([]),
  agentTemplates: z
    .array(
      z.object({
        key: packageKeySchema,
        title: z.string().trim().min(1).max(200),
        promptRef: packageKeySchema.optional(),
        skillRefs: z.array(packageKeySchema).default([]),
        mcpBundleRefs: z.array(packageKeySchema).default([]),
      }),
    )
    .default([]),
  permissionPolicies: z
    .array(
      z.object({
        key: permissionKeySchema,
        gate: approvalGateSchema,
        reason: z.string().trim().min(1).max(500),
      }),
    )
    .default([]),
  requiredSecretInputs: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120).regex(/^[A-Z_][A-Z0-9_]*$/),
        scope: z.enum(["mcp", "agent", "package", "runtime"]),
        required: z.boolean().default(true),
      }),
    )
    .default([]),
});
export type PaperclipOrgPackageManifest = z.infer<typeof paperclipOrgPackageManifestSchema>;
export type PackageApprovalGate = z.infer<typeof approvalGateSchema>;

export interface OrgPackagePreviewContext {
  existingPackageKeys: string[];
  existingAgentTemplateKeys: string[];
  existingSkillKeys: string[];
}

export interface OrgPackageInstallPreview {
  action: "create" | "update";
  requiresApproval: boolean;
  conflicts: string[];
  summary: {
    skills: number;
    prompts: number;
    mcpBundles: number;
    agentTemplates: number;
    permissionPolicies: number;
  };
  secretInputs: Array<{ name: string; scope: "mcp" | "agent" | "package" | "runtime"; required: boolean }>;
  provenance: PaperclipOrgPackageManifest["provenance"];
}

export function buildOrgPackageInstallPreview(
  manifestLike: PaperclipOrgPackageManifest,
  context: OrgPackagePreviewContext,
): OrgPackageInstallPreview {
  const manifest = paperclipOrgPackageManifestSchema.parse(manifestLike);
  const conflicts: string[] = [];

  if (context.existingPackageKeys.includes(manifest.key)) {
    conflicts.push(`package ${manifest.key} already exists`);
  }
  for (const template of manifest.agentTemplates) {
    if (context.existingAgentTemplateKeys.includes(template.key)) {
      conflicts.push(`agent template ${template.key} already exists`);
    }
  }
  for (const skill of manifest.skills) {
    if (context.existingSkillKeys.includes(skill.key)) {
      conflicts.push(`skill ${skill.key} already exists`);
    }
  }

  const hasGovernedChanges =
    manifest.prompts.length > 0 ||
    manifest.mcpBundles.length > 0 ||
    manifest.agentTemplates.length > 0 ||
    manifest.permissionPolicies.length > 0 ||
    manifest.requiredSecretInputs.length > 0;

  return {
    action: context.existingPackageKeys.includes(manifest.key) ? "update" : "create",
    requiresApproval: hasGovernedChanges || conflicts.length > 0,
    conflicts,
    summary: {
      skills: manifest.skills.length,
      prompts: manifest.prompts.length,
      mcpBundles: manifest.mcpBundles.length,
      agentTemplates: manifest.agentTemplates.length,
      permissionPolicies: manifest.permissionPolicies.length,
    },
    secretInputs: manifest.requiredSecretInputs.map((input) => ({
      name: input.name,
      scope: input.scope,
      required: input.required,
    })),
    provenance: manifest.provenance,
  };
}
