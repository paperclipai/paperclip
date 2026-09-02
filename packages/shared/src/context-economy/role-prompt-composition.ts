// Paperclip-side role prompt composition / narrowing.
//
// The Engineer baseline instructions and the common heartbeat boilerplate live
// in an external source (the Kompas Zbiórek wiki / agent AGENTS.md). Paperclip
// must not duplicate or re-inject the full text; instead it composes the
// injected section set per role + task category so only the mandatory contract
// and the category-relevant lazy-load sections are sent. This keeps the
// Paperclip-controlled baseline under the char budgets without editing the
// external repo.

import type { AgentRole, TaskCategory } from "./role-mcp-profiles.js";

export type InstructionSection =
  | "execution-contract"
  | "workspace-fail-closed"
  | "security"
  | "run-scoped-mutation"
  | "dod-disposition"
  | "windows-safety"
  | "anti-churn"
  | "product-ui-api-branding"
  | "interaction-api-howto"
  | "plan-approval"
  | "recovery";

export type HeartbeatSection =
  | "execution-contract"
  | "final-disposition"
  | "control-plane-write-retry"
  | "security-workspace-rules"
  | "interaction-api-howto"
  | "plan-approval"
  | "recovery";

/** Sections always injected for any Engineer run (mandatory contract). */
const ENGINEER_MANDATORY: InstructionSection[] = [
  "execution-contract",
  "workspace-fail-closed",
  "security",
  "run-scoped-mutation",
  "dod-disposition",
  "windows-safety",
  "anti-churn",
];

/** Sections only lazy-loaded for UI/infra task categories. */
const CATEGORY_LAZY_SECTIONS: Partial<Record<TaskCategory, InstructionSection[]>> = {
  ui: ["product-ui-api-branding"],
  infra: ["product-ui-api-branding"],
};

export interface SelectInstructionSectionsInput {
  role: AgentRole;
  taskCategory?: TaskCategory;
}

/**
 * Select the Paperclip-injected instruction sections for a role. Mandatory
 * contract sections are always included; product/UI/API/branding-specific
 * reading lists are gated behind the task category so a plain technical
 * Engineer run does not receive them.
 */
export function selectInstructionSections(
  input: SelectInstructionSectionsInput,
): InstructionSection[] {
  if (input.role !== "engineer") {
    // Other roles inherit the mandatory contract; widen here only if needed.
    return [...ENGINEER_MANDATORY];
  }
  const sections = new Set<InstructionSection>(ENGINEER_MANDATORY);
  const category = (input.taskCategory ?? "technical") as TaskCategory;
  for (const section of CATEGORY_LAZY_SECTIONS[category] ?? []) {
    sections.add(section);
  }
  return [...sections];
}

const HEARTBEAT_MANDATORY: HeartbeatSection[] = [
  "execution-contract",
  "final-disposition",
  "control-plane-write-retry",
  "security-workspace-rules",
];

const HEARTBEAT_LAZY: Partial<Record<TaskCategory, HeartbeatSection[]>> = {
  ui: ["interaction-api-howto", "plan-approval"],
  infra: ["interaction-api-howto"],
};

export interface SelectHeartbeatSectionsInput {
  taskCategory?: TaskCategory;
  /** Rare recovery path; only set when the run was restored from recovery. */
  recovery?: boolean;
}

/**
 * Select the common first-turn heartbeat boilerplate sections. The mandatory
 * set keeps the execution contract, final disposition, control-plane write
 * retry bound, and security/workspace rules; interaction API how-to, plan
 * approval, and rare recovery instructions move behind conditional branches.
 */
export function selectHeartbeatSections(
  input: SelectHeartbeatSectionsInput = {},
): HeartbeatSection[] {
  const sections = new Set<HeartbeatSection>(HEARTBEAT_MANDATORY);
  const category = (input.taskCategory ?? "technical") as TaskCategory;
  for (const section of HEARTBEAT_LAZY[category] ?? []) {
    sections.add(section);
  }
  if (input.recovery) {
    sections.add("recovery");
  }
  return [...sections];
}

export const ENGINEER_BASELINE_CHAR_BUDGET = 6000;
export const HEARTBEAT_CHAR_BUDGET = 2000;
