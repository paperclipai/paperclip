import type {
  CapabilityAssertionClass,
  CapabilityDiffChangeKind,
  CapabilityParityStatus,
  CapabilityPrimaryDisposition,
} from "@paperclip-runner-local/capability";

/**
 * The canonical label vocabulary from the interaction map §0. Every badge,
 * facet value, and status string in the explorer resolves through this module,
 * so the vocabulary stays systematic and no view invents its own wording.
 */

export const DISPOSITION_LABEL: Record<CapabilityPrimaryDisposition, string> = {
  control_plane_owned: "Control plane",
  always_agent_tool: "Always tool",
  optional_agent_tool: "Optional tool",
};

export const DISPOSITION_TONE: Record<CapabilityPrimaryDisposition, "neutral" | "accent" | "success"> = {
  control_plane_owned: "neutral",
  always_agent_tool: "success",
  optional_agent_tool: "accent",
};

export const ASSERTION_CLASS_LABEL: Record<CapabilityAssertionClass, string> = {
  control_plane_invariant: "Invariant",
  agent_tool_contract: "Tool contract",
  authorization_policy: "Authorization",
  combined_multi_hop: "Multi-hop",
  restraint_no_call: "Restraint",
};

export const PARITY_LABEL: Record<CapabilityParityStatus, string> = {
  pass: "Pass",
  fail: "Fail",
  intentional_gap: "Intentional gap",
  not_run: "Not run",
};

/** Status is never encoded by colour alone (WCAG colour-independence). */
export const PARITY_ICON: Record<CapabilityParityStatus, string> = {
  pass: "✓",
  fail: "✕",
  intentional_gap: "◑",
  not_run: "○",
};

export const PARITY_TONE: Record<CapabilityParityStatus, "success" | "danger" | "warning" | "neutral"> = {
  pass: "success",
  fail: "danger",
  intentional_gap: "warning",
  not_run: "neutral",
};

export const CHANGE_LABEL: Record<CapabilityDiffChangeKind, string> = {
  added: "Added",
  changed: "Changed",
  removed: "Removed",
};

export const CHANGE_ICON: Record<CapabilityDiffChangeKind, string> = {
  added: "+",
  changed: "~",
  removed: "−",
};

export const ROLE_LABEL: Record<string, string> = {
  engineer: "Engineer",
  manager: "Manager",
  reviewer: "Reviewer",
  board: "Board",
};

export const TASK_MODE_LABEL: Record<string, string> = {
  standard: "Standard",
  ask: "Ask",
  planning: "Planning",
  skill_test: "Skill test",
};

export const GROUP_LABEL: Record<string, string> = {
  hb: "Heartbeat",
  co: "Context",
  st: "Status",
  cm: "Comments",
  se: "Search",
  su: "Subtasks",
  bl: "Blockers",
  dp: "Documents",
  ix: "Interactions",
  ap: "Approvals",
  ar: "Artifacts",
  er: "Errors",
  rf: "Reference surface",
  mh: "Multi-hop",
  rs: "Restraint",
  wk: "Work modes",
};

export function groupLabel(group: string): string {
  return GROUP_LABEL[group] ?? group;
}

export function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "allowed":
      return "Allow";
    case "denied":
      return "Deny";
    case "absent":
      return "Absent";
    case "exposed":
      return "Exposed";
    default:
      return outcome;
  }
}

export function outcomeTone(outcome: string): "success" | "danger" | "neutral" {
  if (outcome === "allowed" || outcome === "exposed") return "success";
  if (outcome === "denied") return "danger";
  return "neutral";
}
