/**
 * Role-based provisioning preset configuration.
 *
 * Maps Raava agent roles (from AGENT_ROLES in packages/shared/src/constants.ts)
 * to FleetOS provisioning defaults including template, system prompt orientation,
 * and integration hints.
 */

export interface RolePreset {
  /** FleetOS template name */
  template: string;
  /** System prompt orientation for the role */
  systemPromptHint: string;
  /** Default integrations to enable */
  integrations: string[];
  /** Extra provisioning fields passed to FleetOS */
  extraFields?: Record<string, string>;
}

const DEFAULT_TEMPLATE = "hermes";

/**
 * Presets keyed by the actual AGENT_ROLES values:
 * ceo, cto, cmo, cfo, engineer, designer, pm, qa, devops, researcher, general
 */
export const ROLE_PRESETS: Record<string, RolePreset> = {
  ceo: {
    template: DEFAULT_TEMPLATE,
    systemPromptHint: "executive-leadership",
    integrations: ["crm", "email", "calendar", "bi-tools"],
    extraFields: {
      system_prompt_role: "ceo",
    },
  },
  cto: {
    template: DEFAULT_TEMPLATE,
    systemPromptHint: "technical-leadership",
    integrations: ["code-review", "ci-cd", "monitoring", "architecture"],
    extraFields: {
      system_prompt_role: "cto",
    },
  },
  cmo: {
    template: DEFAULT_TEMPLATE,
    systemPromptHint: "marketing-leadership",
    integrations: ["content-management", "social-media", "analytics", "email"],
    extraFields: {
      system_prompt_role: "cmo",
    },
  },
  cfo: {
    template: DEFAULT_TEMPLATE,
    systemPromptHint: "finance-leadership",
    integrations: ["accounting", "bi-tools", "reporting", "budgeting"],
    extraFields: {
      system_prompt_role: "cfo",
    },
  },
  engineer: {
    template: DEFAULT_TEMPLATE,
    systemPromptHint: "software-engineering",
    integrations: ["code-review", "ci-cd", "ticketing"],
    extraFields: {
      system_prompt_role: "engineer",
    },
  },
  designer: {
    template: DEFAULT_TEMPLATE,
    systemPromptHint: "design",
    integrations: ["design-tools", "prototyping", "asset-management"],
    extraFields: {
      system_prompt_role: "designer",
    },
  },
  pm: {
    template: DEFAULT_TEMPLATE,
    systemPromptHint: "product-management",
    integrations: ["ticketing", "roadmap", "analytics", "calendar"],
    extraFields: {
      system_prompt_role: "pm",
    },
  },
  qa: {
    template: DEFAULT_TEMPLATE,
    systemPromptHint: "quality-assurance",
    integrations: ["testing", "ci-cd", "ticketing", "monitoring"],
    extraFields: {
      system_prompt_role: "qa",
    },
  },
  devops: {
    template: DEFAULT_TEMPLATE,
    systemPromptHint: "devops-infrastructure",
    integrations: ["ci-cd", "monitoring", "cloud-infra", "logging"],
    extraFields: {
      system_prompt_role: "devops",
    },
  },
  researcher: {
    template: DEFAULT_TEMPLATE,
    systemPromptHint: "research-analysis",
    integrations: ["data-warehouse", "bi-tools", "knowledge-base"],
    extraFields: {
      system_prompt_role: "researcher",
    },
  },
  general: {
    template: DEFAULT_TEMPLATE,
    systemPromptHint: "general-purpose",
    integrations: [],
    extraFields: {
      system_prompt_role: "general",
    },
  },
};

/**
 * Resolve the provisioning preset for a given agent role.
 * Falls back to the "general" preset if the role is not recognized.
 */
export function resolveRolePreset(role: string): RolePreset {
  const normalized = role.toLowerCase().trim();
  return ROLE_PRESETS[normalized] ?? ROLE_PRESETS.general;
}
