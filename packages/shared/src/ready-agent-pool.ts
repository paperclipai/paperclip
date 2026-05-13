import type { MissionControlApprovalGate } from "./mission-control.js";

export interface AgentBlueprintPermissionPolicy {
  key: string;
  gate: MissionControlApprovalGate;
  reason: string;
}

export interface AgentBlueprintBudget {
  maxRunsPerDay: number;
  maxSpendCentsPerDay: number;
}

export interface AgentBlueprint {
  key: string;
  title: string;
  category: "leadership" | "research" | "engineering" | "growth" | "compliance" | "qa" | "integration";
  systemPrompt: string;
  requiredSkillRefs: string[];
  mcpBundleRefs: string[];
  permissionPolicies: AgentBlueprintPermissionPolicy[];
  requiredSecretInputs: string[];
  runtimeDefaults: {
    adapter: "hermes" | "claude" | "process";
    modelProfile: "fast" | "balanced" | "strong";
  };
  budget: AgentBlueprintBudget;
  validationContract: string[];
}

export interface AgentProvisioningPreviewContext {
  targetCompanyId: string;
  targetProjectId?: string | null;
  existingAgentKeys: string[];
  availableSkillKeys: string[];
  availableMcpBundleKeys: string[];
  providedSecretInputNames: string[];
}

export interface AgentProvisioningPreview {
  action: "create_agent" | "blocked_duplicate";
  blueprintKey: string;
  targetCompanyId: string;
  targetProjectId: string | null;
  requiresApproval: true;
  promptPreview: string;
  missingSkillRefs: string[];
  missingMcpBundleRefs: string[];
  missingSecretInputs: string[];
  permissionSummary: AgentBlueprintPermissionPolicy[];
  budget: AgentBlueprintBudget;
}

export interface AgentReadinessCheckContext {
  availableSkillKeys: string[];
  availableMcpBundleKeys: string[];
  providedSecretInputNames: string[];
  promptRendered: boolean;
  permissionPoliciesReviewed: boolean;
}

export interface AgentReadinessCheck {
  key: "prompt_rendered" | "skills" | "mcp_bundles" | "secret_inputs" | "permission_review";
  status: "pass" | "fail";
  message: string;
}

export interface AgentReadinessResult {
  ready: boolean;
  checks: AgentReadinessCheck[];
}

function blueprint(input: AgentBlueprint): AgentBlueprint {
  return input;
}

export const INITIAL_READY_AGENT_BLUEPRINTS: AgentBlueprint[] = [
  blueprint({
    key: "ceo-pm",
    title: "CEO/PM",
    category: "leadership",
    systemPrompt: "You are a CEO/PM agent. Decompose strategy into issues, approvals, and validator-gated outcomes.",
    requiredSkillRefs: ["paperclip-agent-operations", "writing-plans"],
    mcpBundleRefs: [],
    permissionPolicies: [{ key: "paperclip.issue.write", gate: "lead", reason: "Creates and updates planning issues." }],
    requiredSecretInputs: [],
    runtimeDefaults: { adapter: "hermes", modelProfile: "strong" },
    budget: { maxRunsPerDay: 20, maxSpendCentsPerDay: 2_000 },
    validationContract: ["Issue tree has owners", "Final delivery policy is configured", "No live external action without approval"],
  }),
  blueprint({
    key: "research-analyst",
    title: "Research Analyst",
    category: "research",
    systemPrompt: "You are a research analyst. Produce sourced briefs and identify uncertainty before recommendations.",
    requiredSkillRefs: ["purchase-decision-research"],
    mcpBundleRefs: [],
    permissionPolicies: [],
    requiredSecretInputs: [],
    runtimeDefaults: { adapter: "hermes", modelProfile: "balanced" },
    budget: { maxRunsPerDay: 15, maxSpendCentsPerDay: 1_000 },
    validationContract: ["Sources listed", "Assumptions labeled", "No fabricated current facts"],
  }),
  blueprint({
    key: "code-implementer",
    title: "Code Implementer",
    category: "engineering",
    systemPrompt: "You are a code implementer. Use TDD, branch/diff/tests, and avoid live mutations without approval.",
    requiredSkillRefs: ["test-driven-development", "github-pr-workflow"],
    mcpBundleRefs: [],
    permissionPolicies: [{ key: "repo.write", gate: "lead", reason: "Writes code on feature branches." }],
    requiredSecretInputs: [],
    runtimeDefaults: { adapter: "claude", modelProfile: "strong" },
    budget: { maxRunsPerDay: 12, maxSpendCentsPerDay: 2_500 },
    validationContract: ["RED test recorded", "Targeted tests pass", "Secret scan clean"],
  }),
  blueprint({
    key: "code-reviewer",
    title: "Code Reviewer",
    category: "engineering",
    systemPrompt: "You are a code reviewer. Review diffs for spec gaps, security, and regressions; return actionable fixes.",
    requiredSkillRefs: ["requesting-code-review"],
    mcpBundleRefs: [],
    permissionPolicies: [],
    requiredSecretInputs: [],
    runtimeDefaults: { adapter: "claude", modelProfile: "strong" },
    budget: { maxRunsPerDay: 20, maxSpendCentsPerDay: 1_500 },
    validationContract: ["Security concerns explicit", "Logic errors explicit", "PASS only when clean"],
  }),
  blueprint({
    key: "growth-analyst",
    title: "Growth Analyst",
    category: "growth",
    systemPrompt: "You are a growth analyst. Find distribution opportunities and quantify risk/reward candidly.",
    requiredSkillRefs: ["humanizer"],
    mcpBundleRefs: [],
    permissionPolicies: [{ key: "growth.draft", gate: "lead", reason: "Drafts campaigns but does not send them." }],
    requiredSecretInputs: [],
    runtimeDefaults: { adapter: "hermes", modelProfile: "balanced" },
    budget: { maxRunsPerDay: 12, maxSpendCentsPerDay: 1_200 },
    validationContract: ["Country-law compliance risks noted", "No live outreach send"],
  }),
  blueprint({
    key: "outreach-drafter",
    title: "Outreach Drafter",
    category: "growth",
    systemPrompt: "You are an outreach drafter. Write drafts only; live sends require operator approval.",
    requiredSkillRefs: ["humanizer"],
    mcpBundleRefs: [],
    permissionPolicies: [{ key: "outreach.live_send", gate: "board", reason: "Live outreach is externally visible." }],
    requiredSecretInputs: [],
    runtimeDefaults: { adapter: "hermes", modelProfile: "fast" },
    budget: { maxRunsPerDay: 20, maxSpendCentsPerDay: 800 },
    validationContract: ["Draft-only by default", "Approval required before send"],
  }),
  blueprint({
    key: "compliance-reviewer",
    title: "Compliance Reviewer",
    category: "compliance",
    systemPrompt: "You are a compliance reviewer. Identify legal, data, and permission risks before execution.",
    requiredSkillRefs: ["systematic-debugging"],
    mcpBundleRefs: [],
    permissionPolicies: [],
    requiredSecretInputs: [],
    runtimeDefaults: { adapter: "hermes", modelProfile: "strong" },
    budget: { maxRunsPerDay: 12, maxSpendCentsPerDay: 1_500 },
    validationContract: ["Risk class assigned", "Approval gate identified", "Secrets not exposed"],
  }),
  blueprint({
    key: "qa-visual-tester",
    title: "QA/Visual Tester",
    category: "qa",
    systemPrompt: "You are a QA/Visual Tester. Run production-safe smoke and visual checks with redacted evidence artifacts.",
    requiredSkillRefs: ["dogfood", "test-driven-development"],
    mcpBundleRefs: [],
    permissionPolicies: [],
    requiredSecretInputs: [],
    runtimeDefaults: { adapter: "hermes", modelProfile: "balanced" },
    budget: { maxRunsPerDay: 10, maxSpendCentsPerDay: 1_000 },
    validationContract: ["No live external sends", "Screenshots redacted", "PDF/ZIP/MD evidence generated"],
  }),
  blueprint({
    key: "mcp-integration-operator",
    title: "MCP Integration Operator",
    category: "integration",
    systemPrompt: "You are an MCP Integration Operator. Discover MCP servers, preview installs, classify tool risk, and request approval before enabling.",
    requiredSkillRefs: ["native-mcp", "paperclip-agent-operations"],
    mcpBundleRefs: ["mcp-marketplace-readonly"],
    permissionPolicies: [{ key: "mcp.install", gate: "board", reason: "MCP installs can introduce external tools and secret inputs." }],
    requiredSecretInputs: ["MCP_REGISTRY_TOKEN"],
    runtimeDefaults: { adapter: "hermes", modelProfile: "balanced" },
    budget: { maxRunsPerDay: 8, maxSpendCentsPerDay: 1_500 },
    validationContract: ["Install preview generated", "Tool policies classified", "No server executed before approval"],
  }),
];

export function getReadyAgentBlueprint(key: string): AgentBlueprint {
  const blueprint = INITIAL_READY_AGENT_BLUEPRINTS.find((candidate) => candidate.key === key);
  if (!blueprint) {
    throw new Error(`Unknown ready-agent blueprint: ${key}`);
  }
  return blueprint;
}

function missing(required: readonly string[], available: readonly string[]): string[] {
  const availableSet = new Set(available);
  return required.filter((value) => !availableSet.has(value));
}

export function buildAgentProvisioningPreview(
  blueprint: AgentBlueprint,
  context: AgentProvisioningPreviewContext,
): AgentProvisioningPreview {
  const duplicate = context.existingAgentKeys.includes(blueprint.key);
  return {
    action: duplicate ? "blocked_duplicate" : "create_agent",
    blueprintKey: blueprint.key,
    targetCompanyId: context.targetCompanyId,
    targetProjectId: context.targetProjectId ?? null,
    requiresApproval: true,
    promptPreview: `${blueprint.title}\n\n${blueprint.systemPrompt}`,
    missingSkillRefs: missing(blueprint.requiredSkillRefs, context.availableSkillKeys),
    missingMcpBundleRefs: missing(blueprint.mcpBundleRefs, context.availableMcpBundleKeys),
    missingSecretInputs: missing(blueprint.requiredSecretInputs, context.providedSecretInputNames),
    permissionSummary: blueprint.permissionPolicies,
    budget: blueprint.budget,
  };
}

export function runAgentReadinessChecks(
  blueprint: AgentBlueprint,
  context: AgentReadinessCheckContext,
): AgentReadinessResult {
  const missingSkills = missing(blueprint.requiredSkillRefs, context.availableSkillKeys);
  const missingMcpBundles = missing(blueprint.mcpBundleRefs, context.availableMcpBundleKeys);
  const missingSecretInputs = missing(blueprint.requiredSecretInputs, context.providedSecretInputNames);
  const checks: AgentReadinessCheck[] = [
    {
      key: "prompt_rendered",
      status: context.promptRendered ? "pass" : "fail",
      message: context.promptRendered ? "Prompt renders successfully." : "Prompt rendering must pass before activation.",
    },
    {
      key: "skills",
      status: missingSkills.length === 0 ? "pass" : "fail",
      message: missingSkills.length === 0 ? "All required skills are available." : `Missing skills: ${missingSkills.join(", ")}`,
    },
    {
      key: "mcp_bundles",
      status: missingMcpBundles.length === 0 ? "pass" : "fail",
      message: missingMcpBundles.length === 0 ? "All MCP bundle references are available." : `Missing MCP bundles: ${missingMcpBundles.join(", ")}`,
    },
    {
      key: "secret_inputs",
      status: missingSecretInputs.length === 0 ? "pass" : "fail",
      message: missingSecretInputs.length === 0 ? "All named secret inputs are bound." : `Missing named secret inputs: ${missingSecretInputs.join(", ")}`,
    },
    {
      key: "permission_review",
      status: context.permissionPoliciesReviewed ? "pass" : "fail",
      message: context.permissionPoliciesReviewed ? "Permission policies reviewed." : "Permission policy review is required before activation.",
    },
  ];
  return {
    ready: checks.every((check) => check.status === "pass"),
    checks,
  };
}
