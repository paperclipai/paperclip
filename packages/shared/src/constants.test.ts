import { describe, expect, it } from "vitest";
import {
  COMPANY_STATUSES,
  DEPLOYMENT_MODES,
  AGENT_STATUSES,
  AGENT_ADAPTER_TYPES,
  AGENT_ROLES,
  AGENT_ROLE_LABELS,
  ISSUE_STATUSES,
  ISSUE_PRIORITIES,
  GOAL_STATUSES,
  GOAL_LEVELS,
  PROJECT_STATUSES,
  ROUTINE_STATUSES,
  ROUTINE_TRIGGER_KINDS,
  ROUTINE_CONCURRENCY_POLICIES,
  ROUTINE_CATCH_UP_POLICIES,
  APPROVAL_TYPES,
  APPROVAL_STATUSES,
  BUDGET_SCOPE_TYPES,
  BUDGET_THRESHOLD_TYPES,
  BUDGET_WINDOW_KINDS,
  PLUGIN_STATUSES,
  PLUGIN_CATEGORIES,
  PLUGIN_API_VERSION,
  PERMISSION_KEYS,
  JOIN_REQUEST_STATUSES,
  HEARTBEAT_RUN_STATUSES,
  FINANCE_DIRECTIONS,
  PRINCIPAL_TYPES,
} from "./constants.js";

// ============================================================================
// Company constants
// ============================================================================

describe("COMPANY_STATUSES", () => {
  it("includes active, paused, archived", () => {
    expect(COMPANY_STATUSES).toContain("active");
    expect(COMPANY_STATUSES).toContain("paused");
    expect(COMPANY_STATUSES).toContain("archived");
  });

  it("has exactly 3 entries", () => {
    expect(COMPANY_STATUSES).toHaveLength(3);
  });
});

// ============================================================================
// Deployment constants
// ============================================================================

describe("DEPLOYMENT_MODES", () => {
  it("includes local_trusted and authenticated", () => {
    expect(DEPLOYMENT_MODES).toContain("local_trusted");
    expect(DEPLOYMENT_MODES).toContain("authenticated");
  });

  it("has exactly 2 entries", () => {
    expect(DEPLOYMENT_MODES).toHaveLength(2);
  });
});

// ============================================================================
// Agent constants
// ============================================================================

describe("AGENT_STATUSES", () => {
  it("includes active, paused, idle, running, error", () => {
    expect(AGENT_STATUSES).toContain("active");
    expect(AGENT_STATUSES).toContain("paused");
    expect(AGENT_STATUSES).toContain("idle");
    expect(AGENT_STATUSES).toContain("running");
    expect(AGENT_STATUSES).toContain("error");
  });

  it("includes pending_approval and terminated", () => {
    expect(AGENT_STATUSES).toContain("pending_approval");
    expect(AGENT_STATUSES).toContain("terminated");
  });
});

describe("AGENT_ADAPTER_TYPES", () => {
  it("includes process and http", () => {
    expect(AGENT_ADAPTER_TYPES).toContain("process");
    expect(AGENT_ADAPTER_TYPES).toContain("http");
  });

  it("includes claude_local", () => {
    expect(AGENT_ADAPTER_TYPES).toContain("claude_local");
  });

  it("includes codex_local", () => {
    expect(AGENT_ADAPTER_TYPES).toContain("codex_local");
  });

  it("includes cursor and openclaw_gateway", () => {
    expect(AGENT_ADAPTER_TYPES).toContain("cursor");
    expect(AGENT_ADAPTER_TYPES).toContain("openclaw_gateway");
  });

  it("includes remote_trigger", () => {
    expect(AGENT_ADAPTER_TYPES).toContain("remote_trigger");
  });
});

describe("AGENT_ROLES", () => {
  it("includes ceo, cto, engineer", () => {
    expect(AGENT_ROLES).toContain("ceo");
    expect(AGENT_ROLES).toContain("cto");
    expect(AGENT_ROLES).toContain("engineer");
  });

  it("includes pm, qa, devops, researcher, general", () => {
    expect(AGENT_ROLES).toContain("pm");
    expect(AGENT_ROLES).toContain("qa");
    expect(AGENT_ROLES).toContain("devops");
    expect(AGENT_ROLES).toContain("researcher");
    expect(AGENT_ROLES).toContain("general");
  });
});

describe("AGENT_ROLE_LABELS", () => {
  it("maps ceo to CEO", () => {
    expect(AGENT_ROLE_LABELS.ceo).toBe("CEO");
  });

  it("maps cto to CTO", () => {
    expect(AGENT_ROLE_LABELS.cto).toBe("CTO");
  });

  it("maps engineer to Engineer", () => {
    expect(AGENT_ROLE_LABELS.engineer).toBe("Engineer");
  });

  it("maps pm to PM", () => {
    expect(AGENT_ROLE_LABELS.pm).toBe("PM");
  });

  it("maps qa to QA", () => {
    expect(AGENT_ROLE_LABELS.qa).toBe("QA");
  });

  it("has a label for every role", () => {
    for (const role of AGENT_ROLES) {
      expect(AGENT_ROLE_LABELS[role]).toBeTruthy();
    }
  });
});

// ============================================================================
// Issue constants
// ============================================================================

describe("ISSUE_STATUSES", () => {
  it("includes all expected statuses", () => {
    expect(ISSUE_STATUSES).toContain("backlog");
    expect(ISSUE_STATUSES).toContain("todo");
    expect(ISSUE_STATUSES).toContain("in_progress");
    expect(ISSUE_STATUSES).toContain("in_review");
    expect(ISSUE_STATUSES).toContain("done");
    expect(ISSUE_STATUSES).toContain("blocked");
    expect(ISSUE_STATUSES).toContain("cancelled");
  });

  it("has exactly 7 entries", () => {
    expect(ISSUE_STATUSES).toHaveLength(7);
  });
});

describe("ISSUE_PRIORITIES", () => {
  it("includes critical, high, medium, low", () => {
    expect(ISSUE_PRIORITIES).toContain("critical");
    expect(ISSUE_PRIORITIES).toContain("high");
    expect(ISSUE_PRIORITIES).toContain("medium");
    expect(ISSUE_PRIORITIES).toContain("low");
  });

  it("has exactly 4 entries", () => {
    expect(ISSUE_PRIORITIES).toHaveLength(4);
  });
});

// ============================================================================
// Goal constants
// ============================================================================

describe("GOAL_LEVELS", () => {
  it("includes company, team, agent, task", () => {
    expect(GOAL_LEVELS).toContain("company");
    expect(GOAL_LEVELS).toContain("team");
    expect(GOAL_LEVELS).toContain("agent");
    expect(GOAL_LEVELS).toContain("task");
  });
});

describe("GOAL_STATUSES", () => {
  it("includes planned, active, achieved, cancelled", () => {
    expect(GOAL_STATUSES).toContain("planned");
    expect(GOAL_STATUSES).toContain("active");
    expect(GOAL_STATUSES).toContain("achieved");
    expect(GOAL_STATUSES).toContain("cancelled");
  });
});

// ============================================================================
// Project constants
// ============================================================================

describe("PROJECT_STATUSES", () => {
  it("includes backlog, planned, in_progress, completed, cancelled", () => {
    expect(PROJECT_STATUSES).toContain("backlog");
    expect(PROJECT_STATUSES).toContain("planned");
    expect(PROJECT_STATUSES).toContain("in_progress");
    expect(PROJECT_STATUSES).toContain("completed");
    expect(PROJECT_STATUSES).toContain("cancelled");
  });
});

// ============================================================================
// Routine constants
// ============================================================================

describe("ROUTINE_STATUSES", () => {
  it("includes active, paused, archived", () => {
    expect(ROUTINE_STATUSES).toContain("active");
    expect(ROUTINE_STATUSES).toContain("paused");
    expect(ROUTINE_STATUSES).toContain("archived");
  });
});

describe("ROUTINE_TRIGGER_KINDS", () => {
  it("includes schedule, webhook, api", () => {
    expect(ROUTINE_TRIGGER_KINDS).toContain("schedule");
    expect(ROUTINE_TRIGGER_KINDS).toContain("webhook");
    expect(ROUTINE_TRIGGER_KINDS).toContain("api");
  });

  it("has exactly 3 entries", () => {
    expect(ROUTINE_TRIGGER_KINDS).toHaveLength(3);
  });
});

describe("ROUTINE_CONCURRENCY_POLICIES", () => {
  it("includes coalesce_if_active, always_enqueue, skip_if_active", () => {
    expect(ROUTINE_CONCURRENCY_POLICIES).toContain("coalesce_if_active");
    expect(ROUTINE_CONCURRENCY_POLICIES).toContain("always_enqueue");
    expect(ROUTINE_CONCURRENCY_POLICIES).toContain("skip_if_active");
  });
});

describe("ROUTINE_CATCH_UP_POLICIES", () => {
  it("includes skip_missed and enqueue_missed_with_cap", () => {
    expect(ROUTINE_CATCH_UP_POLICIES).toContain("skip_missed");
    expect(ROUTINE_CATCH_UP_POLICIES).toContain("enqueue_missed_with_cap");
  });
});

// ============================================================================
// Approval constants
// ============================================================================

describe("APPROVAL_TYPES", () => {
  it("includes hire_agent", () => {
    expect(APPROVAL_TYPES).toContain("hire_agent");
  });

  it("includes request_board_approval", () => {
    expect(APPROVAL_TYPES).toContain("request_board_approval");
  });

  it("includes budget_override_required", () => {
    expect(APPROVAL_TYPES).toContain("budget_override_required");
  });
});

describe("APPROVAL_STATUSES", () => {
  it("includes pending, approved, rejected", () => {
    expect(APPROVAL_STATUSES).toContain("pending");
    expect(APPROVAL_STATUSES).toContain("approved");
    expect(APPROVAL_STATUSES).toContain("rejected");
  });

  it("includes revision_requested and cancelled", () => {
    expect(APPROVAL_STATUSES).toContain("revision_requested");
    expect(APPROVAL_STATUSES).toContain("cancelled");
  });
});

// ============================================================================
// Budget constants
// ============================================================================

describe("BUDGET_SCOPE_TYPES", () => {
  it("includes company, agent, project", () => {
    expect(BUDGET_SCOPE_TYPES).toContain("company");
    expect(BUDGET_SCOPE_TYPES).toContain("agent");
    expect(BUDGET_SCOPE_TYPES).toContain("project");
  });
});

describe("BUDGET_THRESHOLD_TYPES", () => {
  it("includes soft and hard", () => {
    expect(BUDGET_THRESHOLD_TYPES).toContain("soft");
    expect(BUDGET_THRESHOLD_TYPES).toContain("hard");
  });
});

describe("BUDGET_WINDOW_KINDS", () => {
  it("includes calendar_month_utc and lifetime", () => {
    expect(BUDGET_WINDOW_KINDS).toContain("calendar_month_utc");
    expect(BUDGET_WINDOW_KINDS).toContain("lifetime");
  });
});

// ============================================================================
// Plugin constants
// ============================================================================

describe("PLUGIN_API_VERSION", () => {
  it("is a positive integer", () => {
    expect(typeof PLUGIN_API_VERSION).toBe("number");
    expect(PLUGIN_API_VERSION).toBeGreaterThan(0);
  });
});

describe("PLUGIN_STATUSES", () => {
  it("includes installed, ready, disabled, error", () => {
    expect(PLUGIN_STATUSES).toContain("installed");
    expect(PLUGIN_STATUSES).toContain("ready");
    expect(PLUGIN_STATUSES).toContain("disabled");
    expect(PLUGIN_STATUSES).toContain("error");
  });

  it("includes upgrade_pending and uninstalled", () => {
    expect(PLUGIN_STATUSES).toContain("upgrade_pending");
    expect(PLUGIN_STATUSES).toContain("uninstalled");
  });
});

describe("PLUGIN_CATEGORIES", () => {
  it("includes connector, workspace, automation, ui", () => {
    expect(PLUGIN_CATEGORIES).toContain("connector");
    expect(PLUGIN_CATEGORIES).toContain("workspace");
    expect(PLUGIN_CATEGORIES).toContain("automation");
    expect(PLUGIN_CATEGORIES).toContain("ui");
  });

  it("has exactly 4 entries", () => {
    expect(PLUGIN_CATEGORIES).toHaveLength(4);
  });
});

// ============================================================================
// Permission constants
// ============================================================================

describe("PERMISSION_KEYS", () => {
  it("includes agents:create", () => {
    expect(PERMISSION_KEYS).toContain("agents:create");
  });

  it("includes users:invite", () => {
    expect(PERMISSION_KEYS).toContain("users:invite");
  });

  it("includes joins:approve", () => {
    expect(PERMISSION_KEYS).toContain("joins:approve");
  });
});

// ============================================================================
// Join request constants
// ============================================================================

describe("JOIN_REQUEST_STATUSES", () => {
  it("includes pending_approval, approved, rejected", () => {
    expect(JOIN_REQUEST_STATUSES).toContain("pending_approval");
    expect(JOIN_REQUEST_STATUSES).toContain("approved");
    expect(JOIN_REQUEST_STATUSES).toContain("rejected");
  });
});

// ============================================================================
// Heartbeat constants
// ============================================================================

describe("HEARTBEAT_RUN_STATUSES", () => {
  it("includes queued, running, succeeded, failed", () => {
    expect(HEARTBEAT_RUN_STATUSES).toContain("queued");
    expect(HEARTBEAT_RUN_STATUSES).toContain("running");
    expect(HEARTBEAT_RUN_STATUSES).toContain("succeeded");
    expect(HEARTBEAT_RUN_STATUSES).toContain("failed");
  });

  it("includes cancelled and timed_out", () => {
    expect(HEARTBEAT_RUN_STATUSES).toContain("cancelled");
    expect(HEARTBEAT_RUN_STATUSES).toContain("timed_out");
  });
});

// ============================================================================
// Finance constants
// ============================================================================

describe("FINANCE_DIRECTIONS", () => {
  it("includes debit and credit", () => {
    expect(FINANCE_DIRECTIONS).toContain("debit");
    expect(FINANCE_DIRECTIONS).toContain("credit");
  });

  it("has exactly 2 entries", () => {
    expect(FINANCE_DIRECTIONS).toHaveLength(2);
  });
});

// ============================================================================
// Principal constants
// ============================================================================

describe("PRINCIPAL_TYPES", () => {
  it("includes user and agent", () => {
    expect(PRINCIPAL_TYPES).toContain("user");
    expect(PRINCIPAL_TYPES).toContain("agent");
  });

  it("has exactly 2 entries", () => {
    expect(PRINCIPAL_TYPES).toHaveLength(2);
  });
});

