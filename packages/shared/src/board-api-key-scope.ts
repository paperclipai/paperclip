import { z } from "zod";

/**
 * Frozen by the PAP-16479 revision-3 security contract. Changes to this list
 * or to a preset expansion require a new SecurityEngineer-reviewed revision.
 */
export const BOARD_API_KEY_PERMISSION_KEYS = [
  "companies:read",
  "companies:write",
  "agents:read",
  "agents:write",
  "agents:operate",
  "projects:read",
  "projects:write",
  "issues:read",
  "issues:write",
  "issues:control",
  "goals:read",
  "goals:write",
  "routines:read",
  "routines:write",
  "routines:run",
  "approvals:read",
  "approvals:write",
  "approvals:decide",
  "costs:read",
  "costs:write",
  "activity:read",
  "artifacts:read",
  "artifacts:write",
  "workspaces:read",
  "workspaces:manage",
  "skills:read",
  "skills:manage",
  "tools:read",
  "tools:manage",
  "secrets:read_metadata",
  "secrets:manage",
  "members:read",
  "members:manage",
  "decisions:read",
  "decisions:write",
  "settings:read",
  "settings:write",
  "environments:read",
  "environments:manage",
  "pipelines:read",
  "pipelines:write",
  "search:read",
  "runtime:read",
  "runtime:manage",
  "audit:read",
  "instance:read",
  "instance:manage",
  "companies:create",
  "companies:import_export",
  "plugins:read",
  "plugins:manage",
  "adapters:read",
  "adapters:manage",
  "users:read",
  "users:manage",
  "catalogs:read",
  "catalogs:manage",
  "backups:create",
  "board_api_keys:revoke_self",
] as const;

export type BoardPermissionKey = (typeof BOARD_API_KEY_PERMISSION_KEYS)[number];

export const BOARD_API_KEY_INSTANCE_CAPABILITIES = ["instance_admin"] as const;
export type BoardApiKeyInstanceCapability = (typeof BOARD_API_KEY_INSTANCE_CAPABILITIES)[number];

const canonicalLowercaseUuidSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase(), "Company IDs must use canonical lowercase UUID text");

function uniqueArray<T extends z.ZodTypeAny>(item: T, min: number, max: number) {
  return z
    .array(item)
    .min(min)
    .max(max)
    .superRefine((values, ctx) => {
      const seen = new Set<unknown>();
      values.forEach((value, index) => {
        if (seen.has(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Duplicate values are not allowed",
            path: [index],
          });
        }
        seen.add(value);
      });
    });
}

/** Strict non-null scope accepted for every post-migration key creation. */
export const boardApiKeyScopeConfigSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("scoped"),
    companyIds: uniqueArray(canonicalLowercaseUuidSchema, 1, 50),
    permissions: uniqueArray(z.enum(BOARD_API_KEY_PERMISSION_KEYS), 1, 59),
    instanceCapabilities: uniqueArray(z.enum(BOARD_API_KEY_INSTANCE_CAPABILITIES), 0, 1),
  })
  .strict();

export type BoardApiKeyScopeConfig = z.infer<typeof boardApiKeyScopeConfigSchema>;

/** Stored values may be null only when the row is explicitly legacy-unrestricted. */
export const storedBoardApiKeyScopeConfigSchema = boardApiKeyScopeConfigSchema.nullable();

const READ_ONLY_PERMISSIONS = [
  "companies:read",
  "agents:read",
  "projects:read",
  "issues:read",
  "goals:read",
  "routines:read",
  "approvals:read",
  "costs:read",
  "activity:read",
  "artifacts:read",
  "workspaces:read",
  "skills:read",
  "tools:read",
  "members:read",
  "decisions:read",
  "settings:read",
  "environments:read",
  "pipelines:read",
  "search:read",
  "runtime:read",
  "audit:read",
] as const satisfies readonly BoardPermissionKey[];

const COMPANY_AUTOMATION_PERMISSIONS = [
  ...READ_ONLY_PERMISSIONS,
  "companies:write",
  "agents:write",
  "agents:operate",
  "projects:write",
  "issues:write",
  "issues:control",
  "goals:write",
  "routines:write",
  "routines:run",
  "approvals:write",
  "costs:write",
  "artifacts:write",
  "workspaces:manage",
  "skills:manage",
  "tools:manage",
  "secrets:read_metadata",
  "secrets:manage",
  "decisions:write",
  "settings:write",
  "environments:manage",
  "pipelines:write",
  "runtime:manage",
  "board_api_keys:revoke_self",
] as const satisfies readonly BoardPermissionKey[];

export const BOARD_API_KEY_SCOPE_PRESETS = {
  read_only: {
    name: "Read-only (company-pinned)",
    permissions: READ_ONLY_PERMISSIONS,
    instanceCapabilities: [] as const,
  },
  company_automation: {
    name: "Company automation",
    permissions: COMPANY_AUTOMATION_PERMISSIONS,
    instanceCapabilities: [] as const,
  },
  full_instance_admin: {
    name: "Full instance admin",
    permissions: BOARD_API_KEY_PERMISSION_KEYS,
    instanceCapabilities: ["instance_admin"] as const,
    helperText: "Grants instance-global actions; company data still requires pinned companies.",
  },
} as const;

export type BoardApiKeyScopePreset = keyof typeof BOARD_API_KEY_SCOPE_PRESETS;

export type BoardApiKeyStatus = "active" | "expires" | "never_expires" | "expired" | "revoked";

export function deriveBoardApiKeyStatus(
  input: { revokedAt: Date | string | null; expiresAt: Date | string | null },
  now: Date = new Date(),
): BoardApiKeyStatus {
  if (input.revokedAt) return "revoked";
  if (!input.expiresAt) return "never_expires";
  return new Date(input.expiresAt).getTime() <= now.getTime() ? "expired" : "expires";
}

export interface BoardApiKeyResponse {
  id: string;
  name: string;
  tokenPrefix: string | null;
  scopeConfig: BoardApiKeyScopeConfig | null;
  legacyUnrestricted: boolean;
  status: BoardApiKeyStatus;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreatedBoardApiKeyResponse extends BoardApiKeyResponse {
  token: string;
}
