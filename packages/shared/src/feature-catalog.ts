import { z } from "zod";
import { instanceExperimentalSettingsSchema } from "./validators/instance.js";

/**
 * Feature catalog for cloud-managed instances.
 *
 * The instance-settings zod schema is the feature manifest; this module adds
 * only metadata about the flags the schema already declares. Keys are derived
 * from the schema type, so adding, removing, or renaming a boolean flag in
 * `instanceExperimentalSettingsSchema` without updating the metadata map is a
 * compile error (and vice versa).
 *
 * Tiers:
 * - `preference`: tenant-controllable taste setting; the cloud harness does
 *   not manage it.
 * - `managed`: the cloud harness may set this per fleet/stack via
 *   `PAPERCLIP_MANAGED_CONFIG`.
 * - `floor`: pinned by code on managed instances; no flag value may widen it.
 */
export const FEATURE_TIERS = ["preference", "managed", "floor"] as const;

export type FeatureTier = (typeof FEATURE_TIERS)[number];

type ExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;

/**
 * The boolean flag keys of the experimental settings schema. Non-flag keys
 * (activation timestamps, numeric tuning values) are excluded.
 */
export type InstanceFeatureKey = {
  [K in keyof ExperimentalSettings]: ExperimentalSettings[K] extends boolean ? K : never;
}[keyof ExperimentalSettings];

export interface FeatureCatalogEntry {
  title: string;
  description: string;
  tier: FeatureTier;
  /** Desired default on cloud-managed instances. */
  cloudDefault: boolean;
  /** Must match the schema default; enforced by test. */
  selfHostedDefault: boolean;
}

export const INSTANCE_FEATURE_CATALOG: Record<InstanceFeatureKey, FeatureCatalogEntry> = {
  enableEnvironments: {
    title: "Environments",
    description:
      "Show environment management in company settings and allow project and agent environment assignment controls.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableNativeRunner: {
    title: "Paperclip Runner",
    description:
      "Allow explicitly configured local Codex, OpenCode, and qualified ACPX agents to use the experimental Rust Paperclip Runner, including authenticated sandbox ingress when required. Onboarding remains on legacy adapters.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableManagedSandboxOnly: {
    title: "Managed Environment Only",
    description:
      "Hide the local environment and run all agents in the platform-managed environment.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableIsolatedWorkspaces: {
    title: "Isolated Workspaces",
    description:
      "Show execution workspace controls in project configuration and allow isolated workspace behavior for task runs.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableStreamlinedLeftNavigation: {
    title: "Streamlined Left Navigation",
    description: "Use the streamlined main sidebar navigation layout.",
    tier: "preference",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableStreamlinedUi: {
    title: "Streamlined UI",
    description:
      "Use the streamlined application shell, shared task collections, focused task detail layout, contextual navigation, and simplified main sidebar.",
    tier: "preference",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableApps: {
    title: "Apps (compatibility)",
    description:
      "Deprecated compatibility key. Apps is always enabled; stored and managed values are ignored.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enablePipelines: {
    title: "Pipelines",
    description: "Enable pipeline definitions and pipeline-driven case production surfaces.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableCases: {
    title: "Cases",
    description:
      "Durable work products that tasks create and iterate on. Adds the Cases tab and the agent case API.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableConferenceRoomChat: {
    title: "Conference Room Chat",
    description:
      "Add the Conference Room team chat, the live activity feed, and the redesigned onboarding; restyles task threads as chat bubbles.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableClassicTaskInterface: {
    title: "Classic Task Interface",
    description:
      "Restore the pre-chat task detail page: the page-level header with inline description editor, the plain comment thread, and the fixed Properties sidebar. Chat-only features (streaming activity folding, inline plan/question cards, the three-mode composer) are unavailable in the classic view.",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableIssuePlanDecompositions: {
    title: "Task Plan Decomposition",
    description: "Show accepted-plan decomposition history on task detail pages.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableExperimentalFileViewer: {
    title: "Experimental File Viewer",
    description:
      "Show task detail controls for browsing and previewing workspace files relative to a task.",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableStatusCards: {
    title: "Status Cards",
    description:
      "Enable the experimental shared status-card board, update engine, and gated API.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableExternalObjects: {
    title: "External Objects",
    description:
      "Detect external URLs in issues and show resolved status for pull requests, tickets, and other referenced work objects.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableSmokeLab: {
    title: "Smoke Lab",
    description:
      "Add the Smoke Lab tab and dashboard card for exercising integration paths against deterministic local fixtures. Private deployments only.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableBuiltInAgents: {
    title: "Built-in Agents",
    description:
      "Show Paperclip-managed built-in agent surfaces, including roster badges, the Built-in agents tab, and setup controls.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableBetaSkills: {
    title: "Beta skills",
    description: "Allow agents to pin beta releases of the Paperclip core skill.",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableSummaries: {
    title: "Summaries",
    description:
      "Show Summarizer-generated status slots on project and workspace pages, with on-demand refresh and revision history.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableDecisions: {
    title: "Decisions",
    description:
      "Show the Decisions item in the main sidebar — the attention home that surfaces tasks awaiting input.",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableGoalsSidebarLink: {
    title: "Goals Sidebar Link",
    description: "Restore the Goals item in the main sidebar while the goals surface is being evaluated.",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableSimplifiedEnglishInteractions: {
    title: "Simplified English Interactions",
    description:
      "Instruct agents to write user interactions (confirmations, questions, suggested tasks) in ASD-STE100 Simplified Technical English with brief decision context.",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableServerInfoDebugView: {
    title: "Server Info Debug View",
    description:
      "Show a Server section in the account drawer with the current server restart time and running commit.",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enablePaperclipDeveloperMode: {
    title: "Paperclip Developer Mode",
    description:
      "Show internal Paperclip maintainer tools and observability links, including Honeycomb trace queries on run pages.",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  autoRestartDevServerWhenIdle: {
    title: "Auto-Restart Dev Server When Idle",
    description:
      "In local development, wait for queued and running agent runs to finish, then restart the server automatically when backend changes make the current boot stale.",
    tier: "preference",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableWorkspaceBranchReconcileForward: {
    title: "Workspace Branch Reconcile Forward",
    description:
      "Let execution workspaces reconcile a diverged recorded branch forward instead of failing branch containment.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableWorkspaceDirtyQuarantineRepair: {
    title: "Workspace Dirty Quarantine Repair",
    description:
      "Let workspace runtime recovery quarantine and repair dirty execution workspaces before runs.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: true,
  },
  enableOwnerInstanceAdmin: {
    title: "Owner Instance Admin",
    description:
      "On cloud-managed instances, grant the stack owner instance-admin access to their own dedicated instance. Elevation is computed at the trusted-header auth boundary; no instance admin role rows are created. Inert on self-hosted instances.",
    tier: "managed",
    cloudDefault: true,
    selfHostedDefault: false,
  },
  enableSandboxDuplexBridge: {
    title: "Sandbox Duplex Bridge",
    description:
      "Let a run open the sandbox duplex command-stream bridge when the provider grants the capability. The host reads this per run before it selects the transport. Off keeps the file bridge for every run.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableRunnerPreviewIngress: {
    title: "Runner Preview Ingress (Deprecated)",
    description:
      "Compatibility-only key retained for older managed configs. Runner ingress follows the Paperclip Runner setting.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
  enableWorktreeRunExecution: {
    title: "Worktree Run Execution",
    description:
      "Let the scheduler execute runs inside an isolated git-worktree preview instance for tasks created after activation.",
    tier: "managed",
    cloudDefault: false,
    selfHostedDefault: false,
  },
};

export const INSTANCE_FEATURE_KEYS = Object.keys(INSTANCE_FEATURE_CATALOG).sort() as InstanceFeatureKey[];

/**
 * Shape of the `feature-catalog.json` release artifact the cloud harness
 * imports per app release and validates feature writes against.
 */
export const featureCatalogArtifactSchema = z
  .object({
    catalogVersion: z.string().min(1),
    features: z.record(
      z.string().min(1),
      z.object({ tier: z.enum(FEATURE_TIERS) }).strict(),
    ),
  })
  .strict();

export type FeatureCatalogArtifact = z.infer<typeof featureCatalogArtifactSchema>;

export function buildFeatureCatalogArtifact(catalogVersion: string): FeatureCatalogArtifact {
  if (catalogVersion.trim().length === 0) {
    throw new Error("catalogVersion must be a non-empty string");
  }
  const features: FeatureCatalogArtifact["features"] = {};
  for (const key of INSTANCE_FEATURE_KEYS) {
    features[key] = { tier: INSTANCE_FEATURE_CATALOG[key].tier };
  }
  return { catalogVersion, features };
}

/** Deterministic serialization (sorted keys, trailing newline) for the artifact file. */
export function renderFeatureCatalogArtifact(catalogVersion: string): string {
  return `${JSON.stringify(buildFeatureCatalogArtifact(catalogVersion), null, 2)}\n`;
}
