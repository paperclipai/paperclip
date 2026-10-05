import type { QualifiedAcpxAgent } from "./qualified-profiles.js";

export interface AcpxCapabilityProfile {
  readonly displayName: string;
  readonly qualification: "qualified" | "pending";
  readonly models: "explicit-provider-verified" | "exact-qualified";
  readonly permissions: "runner-policy" | "interactive";
  readonly questions: "form" | "cursor-extension" | "not-exposed";
  readonly plans: "native" | "cursor-decision" | "semantic-only";
  readonly tools: "authenticated-mcp" | "owned-extension";
  readonly recovery: "session-load" | "unverified";
  readonly toolRefreshOnResume?: boolean;
  readonly usage: "reported" | "unverified";
  readonly steering: "unsupported" | "owned-extension-pending";
  readonly followUp: "controller-queue" | "owned-extension-pending";
  readonly artifacts: "policy_disabled" | "references-pending";
  readonly extensionRequests: readonly string[];
  readonly extensionNotifications: readonly string[];
}

/** These are runner integration claims, not a proxy for everything a harness can do. */
export const ACPX_CAPABILITY_PROFILES: Readonly<Record<QualifiedAcpxAgent, AcpxCapabilityProfile>> = {
  claude: {
    toolRefreshOnResume: true,
    displayName: "Claude", qualification: "qualified", models: "explicit-provider-verified",
    permissions: "interactive", questions: "form", plans: "native", tools: "authenticated-mcp",
    recovery: "session-load", usage: "reported", steering: "unsupported", followUp: "controller-queue",
    artifacts: "policy_disabled", extensionRequests: [], extensionNotifications: [],
  },
  codex: {
    toolRefreshOnResume: true,
    displayName: "Codex", qualification: "qualified", models: "exact-qualified",
    permissions: "runner-policy", questions: "form", plans: "native", tools: "authenticated-mcp",
    recovery: "session-load", usage: "reported", steering: "unsupported", followUp: "controller-queue",
    artifacts: "policy_disabled", extensionRequests: [], extensionNotifications: [],
  },
  grok: {
    toolRefreshOnResume: true,
    displayName: "Grok Build", qualification: "qualified", models: "explicit-provider-verified",
    permissions: "interactive", questions: "form", plans: "native", tools: "authenticated-mcp",
    recovery: "session-load", usage: "unverified", steering: "unsupported", followUp: "controller-queue",
    artifacts: "policy_disabled", extensionRequests: [], extensionNotifications: [],
  },
  cursor: {
    displayName: "Cursor", qualification: "pending", models: "explicit-provider-verified",
    permissions: "interactive", questions: "cursor-extension", plans: "cursor-decision", tools: "authenticated-mcp",
    recovery: "session-load", usage: "unverified", steering: "unsupported", followUp: "controller-queue",
    artifacts: "references-pending",
    extensionRequests: ["cursor/ask_question", "cursor/create_plan", "cursor/update_todos", "cursor/task", "cursor/generate_image"],
    extensionNotifications: ["cursor/update_todos", "cursor/task", "cursor/generate_image", "cursor/subagent_update"],
  },
  copilot: {
    displayName: "GitHub Copilot", qualification: "pending", models: "explicit-provider-verified",
    permissions: "interactive", questions: "not-exposed", plans: "native", tools: "authenticated-mcp",
    recovery: "session-load", usage: "reported", steering: "unsupported", followUp: "controller-queue",
    artifacts: "references-pending", extensionRequests: [],
    extensionNotifications: ["github.com/copilot/sessionEvent"],
  },
  pi: {
    displayName: "Pi", qualification: "pending", models: "exact-qualified",
    permissions: "interactive", questions: "form", plans: "semantic-only", tools: "owned-extension",
    recovery: "session-load", usage: "reported", steering: "owned-extension-pending", followUp: "owned-extension-pending",
    artifacts: "references-pending", extensionRequests: [], extensionNotifications: [],
  },
};
for (const profile of Object.values(ACPX_CAPABILITY_PROFILES)) {
  Object.freeze(profile.extensionRequests);
  Object.freeze(profile.extensionNotifications);
  Object.freeze(profile);
}
Object.freeze(ACPX_CAPABILITY_PROFILES);
