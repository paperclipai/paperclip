import type {
  AgentBlueprint,
  AgentBlueprintBudget,
  AgentBlueprintPermissionPolicy,
} from "./ready-agent-pool.js";

export const BLUEPRINT_LIFECYCLE_STATUSES = [
  "draft",
  "published",
  "deprecated",
] as const;
export type BlueprintLifecycleStatus = (typeof BLUEPRINT_LIFECYCLE_STATUSES)[number];

export const BLUEPRINT_INSTANCE_STATUSES = [
  "preview",
  "pending_approval",
  "approved",
  "rejected",
  "cancelled",
  "applied",
  "failed",
] as const;
export type BlueprintInstanceStatus = (typeof BLUEPRINT_INSTANCE_STATUSES)[number];

export type BlueprintSecretRefBinding = {
  inputName: string;
  secretRef: string;
  configPath?: string;
};

export type BlueprintResolvedSecretBinding = {
  inputName: string;
  secretId: string;
  configPath?: string;
};

export type BlueprintConfigFieldType =
  | "string"
  | "number"
  | "boolean"
  | "enum"
  | "secret_ref";

export type BlueprintConfigField = {
  key: string;
  label: string;
  description?: string;
  type: BlueprintConfigFieldType;
  required?: boolean;
  enumValues?: readonly string[];
  defaultValue?: string | number | boolean | null;
  secretInputName?: string;
};

export type BlueprintConfigSchema = {
  version: 1;
  fields: BlueprintConfigField[];
};

export type BlueprintVersion = {
  ref: string;
  key: string;
  version: string;
  title: string;
  category: AgentBlueprint["category"];
  description: string;
  status: BlueprintLifecycleStatus;
  systemPromptTemplate: string;
  configSchema: BlueprintConfigSchema;
  requiredSkillRefs: readonly string[];
  mcpBundleRefs: readonly string[];
  permissionPolicies: readonly AgentBlueprintPermissionPolicy[];
  requiredSecretInputs: readonly string[];
  requiredProviderKeys: readonly string[];
  runtimeDefaults: AgentBlueprint["runtimeDefaults"];
  budget: AgentBlueprintBudget;
  validationContract: readonly string[];
  source: { kind: "ready_agent_pool"; key: string } | { kind: "custom"; ref: string };
};

export type BlueprintInstantiateInput = {
  config: Record<string, unknown>;
  secretBindings: BlueprintSecretRefBinding[];
  notes?: string | null;
};

export type BlueprintInstantiateContext = {
  companyId: string;
  projectId?: string | null;
  existingAgentKeys: readonly string[];
  availableSkillKeys: readonly string[];
  availableMcpBundleKeys: readonly string[];
  availableSecretInputNames: readonly string[];
  availableProviderKeys: readonly string[];
};

export type BlueprintInstantiateValidationError = {
  code:
    | "feature_disabled"
    | "blueprint_not_found"
    | "duplicate_blueprint_instance"
    | "missing_skill_refs"
    | "missing_mcp_bundle_refs"
    | "missing_secret_inputs"
    | "requires_secret_ref"
    | "missing_provider_key"
    | "invalid_config_field"
    | "raw_secret_value_forbidden";
  message: string;
  details?: Record<string, unknown>;
};

export type BlueprintInstantiateValidation =
  | { kind: "ok" }
  | { kind: "invalid"; errors: BlueprintInstantiateValidationError[] };

export type BlueprintApprovalEvidence = {
  source: "blueprint_catalog";
  version: 1;
  blueprintRef: string;
  blueprintKey: string;
  blueprintVersion: string;
  surface: "agent_os_blueprint";
  approvalScope: "blueprint_instantiate";
  liveApply: false;
  liveExecution: false;
  liveExternalActions: false;
  approvalOnly: true;
  config: Record<string, unknown>;
  secretBindings: BlueprintResolvedSecretBinding[];
  requiredSecretInputs: readonly string[];
  requiredProviderKeys: readonly string[];
  missing: {
    skillRefs: string[];
    mcpBundleRefs: string[];
    secretInputs: string[];
    providerKeys: string[];
  };
  permissionSummary: readonly AgentBlueprintPermissionPolicy[];
  budget: AgentBlueprintBudget;
  generatedAt: string;
  generatedByAgentId: string | null;
  generatedByUserId: string | null;
  notes: string | null;
};

export type BlueprintInstantiatePreview = {
  status: "ready" | "blocked";
  blueprintRef: string;
  blueprintKey: string;
  blueprintVersion: string;
  companyId: string;
  projectId: string | null;
  requiresApproval: true;
  submittable: boolean;
  missing: BlueprintApprovalEvidence["missing"];
  evidence: BlueprintApprovalEvidence;
  errors: BlueprintInstantiateValidationError[];
};

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function missingNames(required: readonly string[], available: readonly string[]): string[] {
  const set = new Set(available);
  return required.filter((name) => !set.has(name));
}

function validateConfigShape(
  schema: BlueprintConfigSchema,
  config: Record<string, unknown>,
): BlueprintInstantiateValidationError[] {
  const errors: BlueprintInstantiateValidationError[] = [];
  for (const field of schema.fields) {
    const raw = config[field.key];
    const present = raw !== undefined && raw !== null && raw !== "";
    if (field.required && !present) {
      errors.push({
        code: "invalid_config_field",
        message: `Field ${field.key} is required`,
        details: { field: field.key },
      });
      continue;
    }
    if (!present) continue;
    if (field.type === "string" || field.type === "enum") {
      if (typeof raw !== "string") {
        errors.push({
          code: "invalid_config_field",
          message: `Field ${field.key} must be a string`,
          details: { field: field.key },
        });
        continue;
      }
      if (field.type === "enum" && field.enumValues && !field.enumValues.includes(raw)) {
        errors.push({
          code: "invalid_config_field",
          message: `Field ${field.key} must be one of: ${field.enumValues.join(", ")}`,
          details: { field: field.key, allowed: [...field.enumValues] },
        });
      }
    } else if (field.type === "number" && typeof raw !== "number") {
      errors.push({
        code: "invalid_config_field",
        message: `Field ${field.key} must be a number`,
        details: { field: field.key },
      });
    } else if (field.type === "boolean" && typeof raw !== "boolean") {
      errors.push({
        code: "invalid_config_field",
        message: `Field ${field.key} must be a boolean`,
        details: { field: field.key },
      });
    } else if (field.type === "secret_ref" && typeof raw !== "string") {
      errors.push({
        code: "invalid_config_field",
        message: `Field ${field.key} must be a secret reference string`,
        details: { field: field.key },
      });
    }
  }
  return errors;
}

const RAW_SECRET_PREFIXES = [
  "sk-",
  "sk_",
  "pk-",
  "pk_",
  "pat_",
  "ghp_",
  "ghs_",
  "gho_",
  "ghr_",
  "github_pat_",
  "xoxb-",
  "xoxp-",
  "AKIA",
  "ASIA",
  "AIza",
  "ya29.",
  "Bearer ",
  "bearer ",
];

// Substring detection: credential-shaped material can appear anywhere inside a
// larger string, including wrapped in quotes/punctuation like `"sk-..."`,
// `(sk-...)`, or `token="sk-..."`. Each regex is intentionally substring-based
// (no `^`/`$`) so surrounding punctuation does not bypass detection.
const RAW_SECRET_PREFIX_SUBSTRING_REGEX =
  /(?:sk-|sk_|pk-|pk_|pat_|ghp_|ghs_|gho_|ghr_|github_pat_|xoxb-|xoxp-|AKIA|ASIA|AIza|ya29\.)[A-Za-z0-9_./:+=\-]{8,}/;
const RAW_BEARER_SUBSTRING_REGEX = /\b[Bb]earer[\s:=]+[A-Za-z0-9_./:+=\-]{12,}/;
// Long opaque token detection: 40+ contiguous chars from a base64-like
// charset. `/` and `.` are intentionally excluded so URLs and dotted paths
// don't false-positive while base64/JWT/raw-key blobs still match.
const RAW_LONG_OPAQUE_SUBSTRING_REGEX = /[A-Za-z0-9_+=\-]{40,}/;

function containsCredentialShapedSubstring(value: string): boolean {
  if (RAW_SECRET_PREFIX_SUBSTRING_REGEX.test(value)) return true;
  if (RAW_BEARER_SUBSTRING_REGEX.test(value)) return true;
  if (RAW_LONG_OPAQUE_SUBSTRING_REGEX.test(value)) return true;
  return false;
}

function looksLikeRawSecretValue(value: string): boolean {
  if (value.length > 64) return true;
  if (/\s/.test(value)) return true;
  if (!/^[A-Za-z0-9_./:-]+$/.test(value)) return true;
  for (const prefix of RAW_SECRET_PREFIXES) {
    if (value.startsWith(prefix)) return true;
  }
  if (containsCredentialShapedSubstring(value)) return true;
  return false;
}

function detectRawSecretValues(
  bindings: BlueprintSecretRefBinding[],
): BlueprintInstantiateValidationError[] {
  const errors: BlueprintInstantiateValidationError[] = [];
  for (const binding of bindings) {
    const trimmed = binding.secretRef?.trim() ?? "";
    if (!trimmed) {
      errors.push({
        code: "requires_secret_ref",
        message: `Secret input ${binding.inputName} requires a secret reference`,
        details: { inputName: binding.inputName },
      });
      continue;
    }
    if (looksLikeRawSecretValue(trimmed)) {
      errors.push({
        code: "raw_secret_value_forbidden",
        message: `Secret input ${binding.inputName} must be a reference, not a raw value`,
        details: { inputName: binding.inputName },
      });
    }
  }
  return errors;
}

function detectRawSecretValuesInConfig(
  config: Record<string, unknown>,
): BlueprintInstantiateValidationError[] {
  const errors: BlueprintInstantiateValidationError[] = [];
  for (const [key, raw] of Object.entries(config)) {
    if (typeof raw !== "string") continue;
    if (!raw.trim()) continue;
    // Scan the full value (not just the trimmed whole-string prefix) so
    // credential-shaped material wrapped in quotes or other punctuation —
    // e.g. `"sk-..."`, `(sk-...)`, `token="sk-..."` — is still caught.
    if (containsCredentialShapedSubstring(raw)) {
      errors.push({
        code: "raw_secret_value_forbidden",
        message: `Config field ${key} must not contain a raw secret value`,
        details: { field: key },
      });
    }
  }
  return errors;
}

function detectRawSecretValuesInNotes(
  notes: string | null | undefined,
): BlueprintInstantiateValidationError[] {
  if (typeof notes !== "string") return [];
  // Notes are freeform multi-line text. Scan the entire string (not just
  // whitespace-separated tokens) so credential-shaped material wrapped in
  // quotes/punctuation — e.g. `"sk-..."`, `(sk-...)`, `token="sk-..."` —
  // is still rejected even when surrounded by other characters.
  if (containsCredentialShapedSubstring(notes)) {
    return [
      {
        code: "raw_secret_value_forbidden",
        message: "Notes must not contain a raw secret value",
        details: { field: "notes" },
      },
    ];
  }
  return [];
}

function sanitizeNotesForEvidence(notes: string | null | undefined): string | null {
  if (typeof notes !== "string") return null;
  if (detectRawSecretValuesInNotes(notes).length > 0) return null;
  return notes;
}

function sanitizeConfigForEvidence(
  schema: BlueprintConfigSchema,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const knownFields = new Map(schema.fields.map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(config)) {
    const field = knownFields.get(key);
    if (!field) continue;
    if (field.type === "secret_ref") continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export function validateBlueprintInstantiateInput(
  version: BlueprintVersion,
  input: BlueprintInstantiateInput,
  context: BlueprintInstantiateContext,
): BlueprintInstantiateValidation {
  const errors: BlueprintInstantiateValidationError[] = [];

  if (context.existingAgentKeys.includes(version.key)) {
    errors.push({
      code: "duplicate_blueprint_instance",
      message: `An agent for blueprint ${version.key} already exists in this company`,
      details: { blueprintKey: version.key },
    });
  }

  errors.push(...validateConfigShape(version.configSchema, input.config));
  errors.push(...detectRawSecretValues(input.secretBindings));
  errors.push(...detectRawSecretValuesInConfig(input.config));
  errors.push(...detectRawSecretValuesInNotes(input.notes));

  const providedSecretInputNames = input.secretBindings
    .map((binding) => asString(binding.inputName))
    .filter((value): value is string => Boolean(value));

  const missingSkills = missingNames(version.requiredSkillRefs, context.availableSkillKeys);
  const missingMcp = missingNames(version.mcpBundleRefs, context.availableMcpBundleKeys);
  const missingSecretInputs = missingNames(version.requiredSecretInputs, providedSecretInputNames);
  const missingProviderKeys = missingNames(version.requiredProviderKeys, context.availableProviderKeys);

  if (missingSkills.length > 0) {
    errors.push({
      code: "missing_skill_refs",
      message: `Missing required skills: ${missingSkills.join(", ")}`,
      details: { missing: missingSkills },
    });
  }
  if (missingMcp.length > 0) {
    errors.push({
      code: "missing_mcp_bundle_refs",
      message: `Missing required MCP bundles: ${missingMcp.join(", ")}`,
      details: { missing: missingMcp },
    });
  }
  if (missingSecretInputs.length > 0) {
    errors.push({
      code: "missing_secret_inputs",
      message: `Missing secret bindings for: ${missingSecretInputs.join(", ")}`,
      details: { missing: missingSecretInputs },
    });
  }
  if (missingProviderKeys.length > 0) {
    errors.push({
      code: "missing_provider_key",
      message: `Provider key not configured: ${missingProviderKeys.join(", ")}`,
      details: { missing: missingProviderKeys },
    });
  }

  if (errors.length === 0) return { kind: "ok" };
  return { kind: "invalid", errors };
}

export function summarizeMissing(
  version: BlueprintVersion,
  input: BlueprintInstantiateInput,
  context: BlueprintInstantiateContext,
): BlueprintApprovalEvidence["missing"] {
  const providedSecretInputNames = input.secretBindings.map((binding) => binding.inputName);
  return {
    skillRefs: missingNames(version.requiredSkillRefs, context.availableSkillKeys),
    mcpBundleRefs: missingNames(version.mcpBundleRefs, context.availableMcpBundleKeys),
    secretInputs: missingNames(version.requiredSecretInputs, providedSecretInputNames),
    providerKeys: missingNames(version.requiredProviderKeys, context.availableProviderKeys),
  };
}

export function buildBlueprintApprovalEvidence(args: {
  version: BlueprintVersion;
  input: BlueprintInstantiateInput;
  resolvedSecretBindings: BlueprintResolvedSecretBinding[];
  missing: BlueprintApprovalEvidence["missing"];
  generatedAt?: Date;
  generatedByAgentId?: string | null;
  generatedByUserId?: string | null;
}): BlueprintApprovalEvidence {
  const generatedAt = (args.generatedAt ?? new Date()).toISOString();
  return {
    source: "blueprint_catalog",
    version: 1,
    blueprintRef: args.version.ref,
    blueprintKey: args.version.key,
    blueprintVersion: args.version.version,
    surface: "agent_os_blueprint",
    approvalScope: "blueprint_instantiate",
    liveApply: false,
    liveExecution: false,
    liveExternalActions: false,
    approvalOnly: true,
    config: sanitizeConfigForEvidence(args.version.configSchema, args.input.config),
    secretBindings: args.resolvedSecretBindings.map((binding) => ({
      inputName: binding.inputName,
      secretId: binding.secretId,
      ...(binding.configPath ? { configPath: binding.configPath } : {}),
    })),
    requiredSecretInputs: args.version.requiredSecretInputs,
    requiredProviderKeys: args.version.requiredProviderKeys,
    missing: args.missing,
    permissionSummary: args.version.permissionPolicies,
    budget: args.version.budget,
    generatedAt,
    generatedByAgentId: args.generatedByAgentId ?? null,
    generatedByUserId: args.generatedByUserId ?? null,
    notes: sanitizeNotesForEvidence(args.input.notes),
  };
}

export function readyAgentBlueprintToVersion(blueprint: AgentBlueprint): BlueprintVersion {
  const fields: BlueprintConfigField[] = [
    {
      key: "displayName",
      label: "Display name",
      description: "Optional display label for this agent instance.",
      type: "string",
      required: false,
    },
  ];
  return {
    ref: `${blueprint.key}@1`,
    key: blueprint.key,
    version: "1",
    title: blueprint.title,
    category: blueprint.category,
    description: blueprint.systemPrompt.split("\n")[0] ?? blueprint.title,
    status: "published",
    systemPromptTemplate: blueprint.systemPrompt,
    configSchema: { version: 1, fields },
    requiredSkillRefs: blueprint.requiredSkillRefs,
    mcpBundleRefs: blueprint.mcpBundleRefs,
    permissionPolicies: blueprint.permissionPolicies,
    requiredSecretInputs: blueprint.requiredSecretInputs,
    requiredProviderKeys: [],
    runtimeDefaults: blueprint.runtimeDefaults,
    budget: blueprint.budget,
    validationContract: blueprint.validationContract,
    source: { kind: "ready_agent_pool", key: blueprint.key },
  };
}
