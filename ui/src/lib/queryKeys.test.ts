// @vitest-environment node

import { describe, expect, it } from "vitest";
import { queryKeys } from "./queryKeys";

// ============================================================================
// Static keys (arrays, not functions)
// ============================================================================

describe("queryKeys — static keys", () => {
  it("companies.all is a constant array", () => {
    expect(queryKeys.companies.all).toEqual(["companies"]);
  });

  it("companies.stats is a constant array", () => {
    expect(queryKeys.companies.stats).toEqual(["companies", "stats"]);
  });

  it("auth.session is a constant array", () => {
    expect(queryKeys.auth.session).toEqual(["auth", "session"]);
  });

  it("health is a constant array", () => {
    expect(queryKeys.health).toEqual(["health"]);
  });

  it("instance.generalSettings is a constant array", () => {
    expect(queryKeys.instance.generalSettings).toEqual(["instance", "general-settings"]);
  });

  it("instance.schedulerHeartbeats is a constant array", () => {
    expect(queryKeys.instance.schedulerHeartbeats).toEqual(["instance", "scheduler-heartbeats"]);
  });

  it("skills.available is a constant array", () => {
    expect(queryKeys.skills.available).toEqual(["skills", "available"]);
  });

  it("plugins.all is a constant array", () => {
    expect(queryKeys.plugins.all).toEqual(["plugins"]);
  });

  it("adapters.all is a constant array", () => {
    expect(queryKeys.adapters.all).toEqual(["adapters"]);
  });
});

// ============================================================================
// companies factory functions
// ============================================================================

describe("queryKeys.companies", () => {
  it("detail includes the provided id", () => {
    const key = queryKeys.companies.detail("comp-1");
    expect(key).toEqual(["companies", "comp-1"]);
  });
});

// ============================================================================
// agents factory functions
// ============================================================================

describe("queryKeys.agents", () => {
  it("list includes companyId", () => {
    expect(queryKeys.agents.list("company-1")).toEqual(["agents", "company-1"]);
  });

  it("detail includes agent id", () => {
    expect(queryKeys.agents.detail("agent-1")).toEqual(["agents", "detail", "agent-1"]);
  });

  it("skills includes agent id", () => {
    expect(queryKeys.agents.skills("agent-1")).toEqual(["agents", "skills", "agent-1"]);
  });

  it("instructionsFile includes id and relative path", () => {
    const key = queryKeys.agents.instructionsFile("agent-1", "CLAUDE.md");
    expect(key).toEqual(["agents", "instructions-bundle", "agent-1", "file", "CLAUDE.md"]);
  });

  it("adapterModels includes companyId and adapterType", () => {
    const key = queryKeys.agents.adapterModels("company-1", "claude_local");
    expect(key).toEqual(["agents", "company-1", "adapter-models", "claude_local"]);
  });
});

// ============================================================================
// issues factory functions
// ============================================================================

describe("queryKeys.issues", () => {
  it("list includes companyId", () => {
    expect(queryKeys.issues.list("company-1")).toEqual(["issues", "company-1"]);
  });

  it("search with defaults uses __all-projects__ and __no-limit__", () => {
    const key = queryKeys.issues.search("company-1", "my query");
    expect(key).toEqual(["issues", "company-1", "search", "my query", "__all-projects__", "__no-limit__"]);
  });

  it("search with explicit projectId and limit", () => {
    const key = queryKeys.issues.search("company-1", "q", "proj-1", 50);
    expect(key).toEqual(["issues", "company-1", "search", "q", "proj-1", 50]);
  });

  it("detail includes issue id", () => {
    expect(queryKeys.issues.detail("issue-1")).toEqual(["issues", "detail", "issue-1"]);
  });

  it("comments includes issueId", () => {
    expect(queryKeys.issues.comments("issue-1")).toEqual(["issues", "comments", "issue-1"]);
  });

  it("documentRevisions includes issueId and key", () => {
    const key = queryKeys.issues.documentRevisions("issue-1", "doc-key");
    expect(key).toEqual(["issues", "document-revisions", "issue-1", "doc-key"]);
  });
});

// ============================================================================
// companySkills factory functions
// ============================================================================

describe("queryKeys.companySkills", () => {
  it("list includes companyId", () => {
    expect(queryKeys.companySkills.list("company-1")).toEqual(["company-skills", "company-1"]);
  });

  it("detail includes companyId and skillId", () => {
    const key = queryKeys.companySkills.detail("company-1", "skill-1");
    expect(key).toEqual(["company-skills", "company-1", "skill-1"]);
  });

  it("file includes companyId, skillId, and path", () => {
    const key = queryKeys.companySkills.file("company-1", "skill-1", "README.md");
    expect(key).toEqual(["company-skills", "company-1", "skill-1", "file", "README.md"]);
  });
});

// ============================================================================
// routines factory functions
// ============================================================================

describe("queryKeys.routines", () => {
  it("list includes companyId", () => {
    expect(queryKeys.routines.list("company-1")).toEqual(["routines", "company-1"]);
  });

  it("detail includes routine id", () => {
    expect(queryKeys.routines.detail("routine-1")).toEqual(["routines", "detail", "routine-1"]);
  });

  it("activity includes companyId and routine id", () => {
    const key = queryKeys.routines.activity("company-1", "routine-1");
    expect(key).toEqual(["routines", "activity", "company-1", "routine-1"]);
  });
});

// ============================================================================
// access factory functions
// ============================================================================

describe("queryKeys.access", () => {
  it("joinRequests defaults to pending_approval status", () => {
    const key = queryKeys.access.joinRequests("company-1");
    expect(key).toEqual(["access", "join-requests", "company-1", "pending_approval"]);
  });

  it("joinRequests accepts explicit status", () => {
    const key = queryKeys.access.joinRequests("company-1", "approved");
    expect(key).toEqual(["access", "join-requests", "company-1", "approved"]);
  });

  it("invite includes token", () => {
    expect(queryKeys.access.invite("tok-123")).toEqual(["access", "invite", "tok-123"]);
  });
});

// ============================================================================
// costs and finance factory functions
// ============================================================================

describe("queryKeys — costs and finance", () => {
  it("costs includes companyId and optional date range", () => {
    const key = queryKeys.costs("company-1", "2026-01-01", "2026-01-31");
    expect(key).toEqual(["costs", "company-1", "2026-01-01", "2026-01-31"]);
  });

  it("costs with undefined dates uses undefined", () => {
    const key = queryKeys.costs("company-1");
    expect(key).toEqual(["costs", "company-1", undefined, undefined]);
  });

  it("financeEvents uses default limit of 100", () => {
    const key = queryKeys.financeEvents("company-1");
    expect(key).toEqual(["finance-events", "company-1", undefined, undefined, 100]);
  });

  it("financeEvents with custom limit", () => {
    const key = queryKeys.financeEvents("company-1", "2026-01-01", "2026-01-31", 250);
    expect(key).toEqual(["finance-events", "company-1", "2026-01-01", "2026-01-31", 250]);
  });
});

// ============================================================================
// sidebarPreferences factory functions
// ============================================================================

describe("queryKeys.sidebarPreferences", () => {
  it("companyOrder includes userId", () => {
    const key = queryKeys.sidebarPreferences.companyOrder("user-1");
    expect(key).toEqual(["sidebar-preferences", "company-order", "user-1"]);
  });

  it("projectOrder includes companyId and userId", () => {
    const key = queryKeys.sidebarPreferences.projectOrder("company-1", "user-1");
    expect(key).toEqual(["sidebar-preferences", "project-order", "company-1", "user-1"]);
  });
});

// ============================================================================
// plugins factory functions
// ============================================================================

describe("queryKeys.plugins", () => {
  it("detail includes pluginId", () => {
    expect(queryKeys.plugins.detail("plugin-1")).toEqual(["plugins", "plugin-1"]);
  });

  it("health includes pluginId", () => {
    expect(queryKeys.plugins.health("plugin-1")).toEqual(["plugins", "plugin-1", "health"]);
  });

  it("logs includes pluginId", () => {
    expect(queryKeys.plugins.logs("plugin-1")).toEqual(["plugins", "plugin-1", "logs"]);
  });
});
