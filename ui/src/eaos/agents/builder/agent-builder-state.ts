// LET-504 — Pure state model + helpers for the manual agent builder at
// `/eaos/agents/new`. Kept separate from the React component so the
// stepper transitions, summary derivation, and unavailable-integration
// classifications can be unit-tested without rendering.
//
// Truthful disabled/placeholder labels are encoded here as the single
// source of truth for "what is real vs. backend gap" — the UI consumes
// these values and never invents a fake-success state.

import { redactSecretLikeText } from "../../secret-redact";

export const AGENT_BUILDER_STEP_IDS = [
  "identity",
  "model",
  "invocations",
  "tools",
  "skills",
  "knowledge",
] as const;

export type AgentBuilderStepId = (typeof AGENT_BUILDER_STEP_IDS)[number];

export interface AgentBuilderStepDescriptor {
  readonly id: AgentBuilderStepId;
  readonly index: number;
  readonly label: string;
  readonly description: string;
}

export const AGENT_BUILDER_STEPS: readonly AgentBuilderStepDescriptor[] = [
  {
    id: "identity",
    index: 1,
    label: "Identity",
    description: "Name, role, and visual identity.",
  },
  {
    id: "model",
    index: 2,
    label: "Model",
    description: "Primary model, thinking budget, and subagent model.",
  },
  {
    id: "invocations",
    index: 3,
    label: "Invocations",
    description: "How this agent is reached: thread, scheduled, channels.",
  },
  {
    id: "tools",
    index: 4,
    label: "Tools",
    description: "Integrations and grouped tool cards.",
  },
  {
    id: "skills",
    index: 5,
    label: "Skills",
    description: "Discovery toggle and agent-specific skills.",
  },
  {
    id: "knowledge",
    index: 6,
    label: "Knowledge",
    description: "Access mode and library wiring.",
  },
] as const;

export type TrustProfileId =
  | "general"
  | "engineer"
  | "designer"
  | "pm"
  | "qa"
  | "security"
  | "researcher"
  | "devops";

export interface TrustProfileOption {
  readonly id: TrustProfileId;
  readonly label: string;
  readonly tagline: string;
}

export const TRUST_PROFILE_OPTIONS: readonly TrustProfileOption[] = [
  { id: "general", label: "General", tagline: "Default, no specialty bias." },
  { id: "engineer", label: "Engineer", tagline: "Code, edits, builds, and tests." },
  { id: "designer", label: "Designer", tagline: "UI, IA, and design QA." },
  { id: "pm", label: "PM", tagline: "Planning, scoping, and coordination." },
  { id: "qa", label: "QA", tagline: "Validation, regression, and evidence." },
  { id: "security", label: "Security", tagline: "Threat review and posture." },
  { id: "researcher", label: "Researcher", tagline: "Reading, synthesis, citations." },
  { id: "devops", label: "DevOps", tagline: "Runtime, CI/CD, and infra." },
];

export const AGENT_THEMES = [
  { id: "slate", label: "Slate", swatch: "#64748b" },
  { id: "indigo", label: "Indigo", swatch: "#6366f1" },
  { id: "emerald", label: "Emerald", swatch: "#10b981" },
  { id: "amber", label: "Amber", swatch: "#f59e0b" },
  { id: "rose", label: "Rose", swatch: "#f43f5e" },
  { id: "cyan", label: "Cyan", swatch: "#06b6d4" },
] as const;

export type AgentThemeId = (typeof AGENT_THEMES)[number]["id"];

export const KNOWLEDGE_ACCESS_MODES = [
  {
    id: "personal",
    label: "Personal",
    tagline: "Only this agent's own memory.",
    backendReady: true,
  },
  {
    id: "curated",
    label: "Curated",
    tagline: "Library packs you select per agent.",
    backendReady: true,
  },
  {
    id: "team",
    label: "Team learning",
    tagline: "Cross-mission knowledge shared across the team.",
    backendReady: false,
    backendGapReason: "Coming soon.",
  },
  {
    id: "custom",
    label: "Custom",
    tagline: "Hand-pick collections, packs, and citations.",
    backendReady: false,
    backendGapReason: "Coming soon.",
  },
] as const;

export type KnowledgeAccessModeId = (typeof KNOWLEDGE_ACCESS_MODES)[number]["id"];

// Invocation channel rows. Only "thread" + "scheduled" are real today;
// everything else is a truthful backend-gap row that the user can see
// but cannot enable until the integration ships.
export type InvocationAvailability =
  | { kind: "available" }
  | { kind: "save-first"; reason: string }
  | { kind: "backend-gap"; reason: string }
  | { kind: "connect"; reason: string };

export interface InvocationChannelRow {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly availability: InvocationAvailability;
}

export function getInvocationChannelRows(
  context: { agentSaved: boolean },
): readonly InvocationChannelRow[] {
  return [
    {
      id: "thread",
      label: "Thread",
      description: "Reply to comments and run from issue threads.",
      availability: { kind: "available" },
    },
    {
      id: "scheduled",
      label: "Scheduled",
      description: "Heartbeat / cron / routine entry-points.",
      availability: { kind: "available" },
    },
    {
      id: "webhook",
      label: "Webhook",
      description: "Wake this agent from an HTTP endpoint.",
      availability: context.agentSaved
        ? { kind: "backend-gap", reason: "Coming soon." }
        : { kind: "save-first", reason: "Available after the agent is created." },
    },
    {
      id: "slack",
      label: "Slack",
      description: "DMs and channel mentions through Slack.",
      availability: { kind: "connect", reason: "Connect a Slack workspace from Admin → Integrations." },
    },
    {
      id: "telegram",
      label: "Telegram",
      description: "Bot replies in Telegram groups and DMs.",
      availability: { kind: "connect", reason: "Connect a Telegram bot from Admin → Integrations." },
    },
    {
      id: "email",
      label: "Email",
      description: "Reply to inbound email threads.",
      availability: { kind: "backend-gap", reason: "Coming soon." },
    },
  ];
}

// Tool groups. Each card is either available, save-first, or backend-gap.
export interface ToolGroupCard {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly group: "execution" | "research" | "data";
  readonly availability: InvocationAvailability;
}

export function getToolGroupCards(
  context: { agentSaved: boolean },
): readonly ToolGroupCard[] {
  const saveFirst = (reason: string): InvocationAvailability =>
    context.agentSaved
      ? { kind: "backend-gap", reason: "Coming soon." }
      : { kind: "save-first", reason };
  return [
    {
      id: "shell",
      title: "Shell + filesystem",
      description: "Bash, Read, Write, Edit, Grep, Glob.",
      group: "execution",
      availability: { kind: "available" },
    },
    {
      id: "browser",
      title: "Headless browser",
      description: "Drive websites and fetch live pages.",
      group: "execution",
      availability: saveFirst("Available after the agent is created."),
    },
    {
      id: "web-search",
      title: "Web search",
      description: "Live web search with citations.",
      group: "research",
      availability: { kind: "available" },
    },
    {
      id: "docs",
      title: "Doc fetcher",
      description: "Read official docs, RFCs, and standards.",
      group: "research",
      availability: { kind: "available" },
    },
    {
      id: "warehouse",
      title: "Data warehouse",
      description: "Read-only query against the company warehouse.",
      group: "data",
      availability: saveFirst("Available after the agent is created."),
    },
    {
      id: "kb",
      title: "Knowledge base",
      description: "Library packs and pinned citations.",
      group: "data",
      availability: { kind: "available" },
    },
  ];
}

// Knowledge discovery rows
export interface KnowledgeRow {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly availability: InvocationAvailability;
}

export function getKnowledgeRows(): readonly KnowledgeRow[] {
  return [
    {
      id: "library",
      label: "Company library",
      description: "Curated playbooks and skills packs.",
      availability: { kind: "available" },
    },
    {
      id: "memory",
      label: "Per-agent memory",
      description: "File-based memory in the agent's workspace.",
      availability: { kind: "available" },
    },
    {
      id: "kb-index",
      label: "Cross-mission knowledge",
      description: "Searchable index across past missions.",
      availability: { kind: "backend-gap", reason: "Coming soon." },
    },
  ];
}

export interface AgentBuilderState {
  // Identity
  readonly name: string;
  readonly description: string;
  readonly trustProfile: TrustProfileId;
  readonly themeId: AgentThemeId;

  // Model
  readonly model: string;
  readonly extendedThinking: boolean;
  readonly perQueryBudgetCents: number;
  readonly subagentModel: string;

  // Invocations
  readonly scheduledEnabled: boolean;
  readonly heartbeatIntervalSec: number;

  // Tools (only "available" cards can be selected; others are read-only)
  readonly selectedToolIds: readonly string[];

  // Skills
  readonly skillDiscoveryEnabled: boolean;
  readonly selectedSkillKeys: readonly string[];

  // Knowledge
  readonly knowledgeDiscoveryEnabled: boolean;
  readonly knowledgeMode: KnowledgeAccessModeId;
}

export const DEFAULT_AGENT_BUILDER_STATE: AgentBuilderState = {
  name: "",
  description: "",
  trustProfile: "general",
  themeId: "indigo",
  model: "claude-opus-4-7",
  extendedThinking: true,
  perQueryBudgetCents: 50,
  subagentModel: "claude-haiku-4-5",
  scheduledEnabled: false,
  heartbeatIntervalSec: 300,
  selectedToolIds: [],
  skillDiscoveryEnabled: true,
  selectedSkillKeys: [],
  knowledgeDiscoveryEnabled: true,
  knowledgeMode: "personal",
};

export interface AgentBuilderSummary {
  readonly displayName: string;
  readonly trustProfileLabel: string;
  readonly themeSwatch: string;
  readonly modelLabel: string;
  readonly thinkingLabel: string;
  readonly budgetLabel: string;
  readonly invocationCount: number;
  readonly invocationLabel: string;
  readonly integrationCount: number;
  readonly integrationLabel: string;
  readonly toolCount: number;
  readonly toolLabel: string;
  readonly skillsLabel: string;
  readonly knowledgeLabel: string;
  readonly canCreate: boolean;
}

const NBSP = " ";

export function summarizeAgentBuilder(state: AgentBuilderState): AgentBuilderSummary {
  const name = state.name.trim();
  const displayName = name ? redactSecretLikeText(name) : "Unnamed agent";
  const trustProfileLabel =
    TRUST_PROFILE_OPTIONS.find((p) => p.id === state.trustProfile)?.label ?? "General";
  const themeSwatch =
    AGENT_THEMES.find((t) => t.id === state.themeId)?.swatch ?? "#6366f1";

  const modelLabel = state.model.trim() || "—";
  const thinkingLabel = state.extendedThinking ? "Extended thinking on" : "Extended thinking off";

  const dollars = state.perQueryBudgetCents / 100;
  const budgetLabel =
    state.perQueryBudgetCents > 0
      ? `$${dollars.toFixed(dollars >= 1 ? 2 : 2)}${NBSP}/${NBSP}query`
      : "No per-query cap";

  // Invocations: thread is always on; scheduled is opt-in; channels (slack,
  // telegram, webhook, email) are not yet enabled, so they do not count
  // toward the live total.
  const invocationCount = 1 + (state.scheduledEnabled ? 1 : 0);
  const invocationLabel = invocationCount === 1 ? "1 invocation" : `${invocationCount} invocations`;

  // Integrations = channels connected from Admin → Integrations. None today.
  const integrationCount = 0;
  const integrationLabel = "None connected";

  const toolCount = state.selectedToolIds.length;
  const toolLabel = toolCount === 1 ? "1 tool selected" : `${toolCount} tools selected`;

  const skillsCount = state.selectedSkillKeys.length;
  const skillsLabel =
    state.skillDiscoveryEnabled
      ? skillsCount === 0
        ? "Discovery on, 0 pinned"
        : `Discovery on, ${skillsCount} pinned`
      : skillsCount === 1
        ? "1 skill pinned"
        : `${skillsCount} skills pinned`;

  const knowledgeModeLabel =
    KNOWLEDGE_ACCESS_MODES.find((m) => m.id === state.knowledgeMode)?.label ?? "Personal";
  const knowledgeLabel = state.knowledgeDiscoveryEnabled
    ? `${knowledgeModeLabel} · discovery on`
    : `${knowledgeModeLabel} · discovery off`;

  const canCreate = Boolean(name) && state.model.trim().length > 0;

  return {
    displayName,
    trustProfileLabel,
    themeSwatch,
    modelLabel,
    thinkingLabel,
    budgetLabel,
    invocationCount,
    invocationLabel,
    integrationCount,
    integrationLabel,
    toolCount,
    toolLabel,
    skillsLabel,
    knowledgeLabel,
    canCreate,
  };
}

export function getStepIndex(stepId: AgentBuilderStepId): number {
  return AGENT_BUILDER_STEPS.findIndex((s) => s.id === stepId);
}

export function nextStep(stepId: AgentBuilderStepId): AgentBuilderStepId {
  const idx = getStepIndex(stepId);
  const nextIdx = Math.min(idx + 1, AGENT_BUILDER_STEPS.length - 1);
  return AGENT_BUILDER_STEPS[nextIdx]!.id;
}

export function previousStep(stepId: AgentBuilderStepId): AgentBuilderStepId {
  const idx = getStepIndex(stepId);
  const prevIdx = Math.max(idx - 1, 0);
  return AGENT_BUILDER_STEPS[prevIdx]!.id;
}

export function isFinalStep(stepId: AgentBuilderStepId): boolean {
  return stepId === AGENT_BUILDER_STEPS[AGENT_BUILDER_STEPS.length - 1]!.id;
}

export function isFirstStep(stepId: AgentBuilderStepId): boolean {
  return stepId === AGENT_BUILDER_STEPS[0]!.id;
}

export function availabilityBadgeText(availability: InvocationAvailability): string {
  switch (availability.kind) {
    case "available":
      return "Available";
    case "save-first":
      return "After create";
    case "backend-gap":
      return "Coming soon";
    case "connect":
      return "Connect";
  }
}

export function isAvailabilityDisabled(availability: InvocationAvailability): boolean {
  return availability.kind !== "available";
}
