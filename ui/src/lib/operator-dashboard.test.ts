import { describe, expect, it } from "vitest";
import type { AttentionItem, AttentionResolverAudience, Issue, IssueOverview } from "@paperclipai/shared";
import {
  attentionItemDecisionViews,
  classifyOutcome,
  countDecisionViews,
  deriveDeliveredOutcomes,
  deriveNextCandidates,
  deriveProjectRollups,
  deriveStuckTasks,
  describeOperatorInventory,
  filterDecisionView,
  loadOperatorDecisionView,
  loadOperatorLastVisit,
  loadOperatorTimeWindow,
  OPERATOR_ISSUE_LOAD_LIMIT,
  recordOperatorVisit,
  resolveOperatorWindow,
  saveOperatorDecisionView,
  saveOperatorTimeWindow,
} from "./operator-dashboard";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-10T12:00:00Z").getTime();

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Ship the thing",
    description: null,
    status: "todo",
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    responsibleUserId: null,
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date(NOW - 10 * DAY),
    updatedAt: new Date(NOW - DAY),
    ...overrides,
  } as unknown as Issue;
}

function overview(overrides: Partial<IssueOverview> = {}): IssueOverview {
  return {
    issueId: "issue-1",
    phase: "done",
    phaseSource: "status",
    blocked: false,
    project: null,
    parent: null,
    children: [],
    childCount: 0,
    completedChildCount: 0,
    blocker: null,
    pullRequests: [],
    delivery: null,
    ...overrides,
  } as unknown as IssueOverview;
}

function attentionItem(
  sourceKind: AttentionItem["sourceKind"],
  overrides: Partial<AttentionItem> = {},
): AttentionItem {
  return {
    id: `attention-${sourceKind}`,
    companyId: "company-1",
    sourceKind,
    subject: {
      kind: "issue",
      id: "issue-1",
      companyId: "company-1",
      title: "Needs a look",
      identifier: "PAP-1",
      status: null,
      href: "/issues/PAP-1",
    },
    whyNow: "Something needs you.",
    decisionVerbs: [],
    inlineResolvable: false,
    entryRule: "test",
    exitRule: "test",
    dedupKey: `test:${sourceKind}`,
    dismissalKey: `test:${sourceKind}`,
    dismissal: null,
    severity: "medium",
    rank: 0,
    activityAt: new Date(NOW).toISOString(),
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    relatedIssue: null,
    project: null,
    workspace: null,
    expiresAt: null,
    ruleKey: null,
    originAgentName: null,
    queues: [],
    shelf: false,
    retentionDays: 30,
    keep: false,
    archivedAt: null,
    retentionVersion: 1,
    decideBy: null,
    decideByAttribution: null,
    snoozedUntil: null,
    detail: null,
    trainingExampleId: null,
    ...overrides,
  } as unknown as AttentionItem;
}

describe("classifyOutcome", () => {
  const mergedPr = {
    url: "https://forge.example/r/1",
    number: 1,
    repository: "acme/app",
    state: "merged",
    updatedAt: null,
    stale: false,
  } as const;

  function coded(overrides: Partial<Issue> = {}): Issue {
    return { ...issue(overrides), deliveryKind: "code" } as Issue;
  }

  function nonCode(overrides: Partial<Issue> = {}): Issue {
    return { ...issue(overrides), deliveryKind: "non_code" } as Issue;
  }

  function mergedDelivery() {
    return { phase: "merged", mergedAt: new Date(NOW).toISOString() } as IssueOverview["delivery"];
  }

  it("verifies only on the current cycle's recorded merge", () => {
    const result = classifyOutcome(
      coded(),
      overview({ pullRequests: [{ ...mergedPr }], delivery: mergedDelivery() }),
    );
    expect(result.verification).toBe("merged");
    expect(result.verificationLabel).toMatch(/verified/i);
    expect(result.area).toBe("code");
    expect(result.areaLabel).toBe("Code");
  });

  it("does not verify on mergedAt without a merged phase", () => {
    const result = classifyOutcome(
      coded(),
      overview({
        pullRequests: [{ ...mergedPr }],
        delivery: { phase: "in_review", mergedAt: new Date(NOW).toISOString() } as IssueOverview["delivery"],
      }),
    );
    expect(result.verification).toBe("merge_unverified");
    expect(result.verificationLabel).not.toMatch(/verified/i);
  });

  it("does not let historical or mixed PRs verify the outcome", () => {
    const lone = classifyOutcome(coded(), overview({ pullRequests: [{ ...mergedPr }] }));
    expect(lone.verification).toBe("merge_unverified");
    expect(lone.verificationLabel).toMatch(/not confirmed/);
    const mixed = classifyOutcome(
      coded(),
      overview({
        pullRequests: [
          { ...mergedPr, url: "https://forge.example/r/1" },
          { ...mergedPr, state: "open", url: "https://forge.example/r/2" },
        ],
      }),
    );
    expect(mixed.verification).toBe("merge_unverified");
    expect(mixed.verificationLabel).toContain("open");
  });

  it("names unknown PR states instead of guessing", () => {
    const result = classifyOutcome(
      coded(),
      overview({ pullRequests: [{ ...mergedPr, state: "unknown" }] }),
    );
    expect(result.verification).toBe("merge_unverified");
    expect(result.verificationLabel).toContain("unknown state");
  });

  it("labels explicit non-code delivery without a business assertion", () => {
    const result = classifyOutcome(nonCode(), overview());
    expect(result.verification).toBe("non_code");
    expect(result.area).toBe("non_code");
    expect(result.areaLabel).toBe("No code");
  });

  it("never infers non-code from workMode or missing PRs", () => {
    const planning = classifyOutcome(issue({ workMode: "planning" }), overview());
    expect(planning.verification).toBe("unlinked");
    expect(planning.area).toBe("unclassified");
    expect(planning.areaLabel).toBe("Unclassified");
    expect(planning.verificationLabel).toBe("Marked done · delivery evidence not recorded");
  });

  it("marks code delivery without recorded evidence exactly as unrecorded", () => {
    const result = classifyOutcome(coded(), overview());
    expect(result.verification).toBe("unlinked");
    expect(result.area).toBe("code");
    expect(result.areaLabel).toBe("Code");
    expect(result.verificationLabel).toBe("Marked done · delivery evidence not recorded");
  });
});

describe("deriveDeliveredOutcomes", () => {
  it("keeps in-window completions newest-first and drops the rest", () => {
    const since = NOW - 7 * DAY;
    const rows = [
      issue({ id: "old", status: "done", completedAt: new Date(NOW - 30 * DAY) }),
      issue({ id: "new", status: "done", completedAt: new Date(NOW - DAY) }),
      issue({ id: "open", status: "in_progress", completedAt: null }),
      issue({ id: "undated", status: "done", completedAt: null }),
    ];
    const byId = new Map<string, IssueOverview>();
    const outcomes = deriveDeliveredOutcomes(rows, byId, since, new Map());
    expect(outcomes.map((o) => o.issueId)).toEqual(["new"]);
  });

  it("sorts root outcomes before subtasks and system tasks", () => {
    const completedAt = new Date(NOW - DAY);
    const rows = [
      issue({ id: "child", status: "done", parentId: "root", completedAt }),
      issue({ id: "system", status: "done", originKind: "stranded_issue_recovery", completedAt }),
      issue({ id: "root", status: "done", completedAt }),
    ];
    const outcomes = deriveDeliveredOutcomes(rows, new Map(), null, new Map());
    expect(outcomes.map((o) => o.issueId)).toEqual(["root", "child", "system"]);
    expect(outcomes.find((o) => o.issueId === "child")).toMatchObject({ isChild: true });
    expect(outcomes.find((o) => o.issueId === "system")).toMatchObject({ isSystemTask: true });
  });
});

describe("deriveStuckTasks", () => {
  const lookup = {
    agentNameById: new Map([["agent-1", "Coder"]]),
    userLabelById: new Map([["user-1", "Ada"]]),
    projectNameById: new Map([["project-1", "Atlas"]]),
  };

  it("prefers the blocker message, then named blockers, then samples", () => {
    const rows = [
      issue({
        id: "a",
        status: "blocked",
        blockedBy: [{ id: "x", identifier: "PAP-9", title: "Upstream" }] as Issue["blockedBy"],
      }),
      issue({ id: "b", status: "blocked" }),
    ];
    const byId = new Map<string, IssueOverview>([
      ["a", overview({ issueId: "a", blocker: { message: "Waiting on vendor", ownerLabel: null, nextAction: null, issues: [] } })],
      ["b", overview({ issueId: "b" })],
    ]);
    const [first, second] = deriveStuckTasks(rows, byId, lookup);
    // Longest-stuck first; both undated here so insertion order holds.
    expect(first.cause).toBe("Waiting on vendor");
    expect(second.cause).toBe("Waiting on PAP-9");
  });

  it("leaves unknown causes and owners visibly empty", () => {
    const [row] = deriveStuckTasks([issue({ status: "blocked" })], new Map(), lookup);
    expect(row.cause).toBeNull();
    expect(row.ownerLabel).toBeNull();
    expect(row.impactLabel).toBeNull();
  });

  it("resolves owners, counts explicit dependents, and labels children separately", () => {
    const rows = deriveStuckTasks(
      [
        issue({
          status: "blocked",
          blockedTransitionAt: new Date(NOW - 3 * DAY) as unknown as Date,
          unblockDescriptor: { owner: "board", action: "Approve the plan" },
          blocks: [
            { id: "x", identifier: "PAP-9", title: "Downstream" },
            { id: "y", identifier: "PAP-10", title: "Also waiting" },
          ] as Issue["blocks"],
        }),
      ],
      new Map([["issue-1", overview({ childCount: 5, completedChildCount: 2 })]]),
      lookup,
    );
    expect(rows[0]?.ownerLabel).toBe("Board");
    expect(rows[0]?.impactLabel).toBe("Blocks 2 tasks · 2 of 5 subtasks done");
    expect(rows[0]?.projected).toBe(false);
  });

  it("includes delivery-projected blocks behind a non-blocked status", () => {
    const rows = deriveStuckTasks(
      [issue({ id: "p", status: "in_progress" }), issue({ id: "q", status: "todo" })],
      new Map([
        ["p", overview({ issueId: "p", blocked: true })],
        ["q", overview({ issueId: "q", blocked: false })],
      ]),
      lookup,
    );
    expect(rows.map((r) => r.issueId)).toEqual(["p"]);
    expect(rows[0]?.projected).toBe(true);
  });

  it("sorts longest-stuck first with unknown starts last", () => {
    const rows = deriveStuckTasks(
      [
        issue({ id: "recent", status: "blocked", blockedTransitionAt: new Date(NOW - DAY) as unknown as Date }),
        issue({ id: "unknown", status: "blocked" }),
        issue({ id: "oldest", status: "blocked", blockedTransitionAt: new Date(NOW - 9 * DAY) as unknown as Date }),
      ],
      new Map(),
      lookup,
    );
    expect(rows.map((r) => r.issueId)).toEqual(["oldest", "recent", "unknown"]);
  });
});

describe("deriveNextCandidates", () => {
  it("orders landing before review before progress before ready", () => {
    const rows = [
      issue({ id: "todo-new", status: "todo", updatedAt: new Date(NOW) }),
      issue({ id: "prog", status: "in_progress", updatedAt: new Date(NOW - 5 * DAY) }),
      issue({ id: "review", status: "in_review", updatedAt: new Date(NOW - 9 * DAY) }),
      issue({ id: "todo-old", status: "todo", updatedAt: new Date(NOW - 9 * DAY) }),
      issue({ id: "merging", status: "merging", updatedAt: new Date(NOW - 9 * DAY) }),
      issue({ id: "rtm", status: "ready_to_merge", updatedAt: new Date(NOW) }),
      issue({ id: "done", status: "done" }),
      issue({ id: "blocked", status: "blocked" }),
      issue({ id: "backlog", status: "backlog" }),
      issue({ id: "cancelled", status: "cancelled" }),
    ];
    const candidates = deriveNextCandidates(rows, new Map(), new Map());
    expect(candidates.map((c) => c.issueId)).toEqual([
      "merging",
      "rtm",
      "review",
      "prog",
      "todo-new",
      "todo-old",
    ]);
    expect(candidates[2]?.reason).toMatch(/verdict/);
  });

  it("excludes delivery-projected blocks even before the status flips", () => {
    const rows = [
      issue({ id: "ok", status: "todo", updatedAt: new Date(NOW) }),
      issue({ id: "held", status: "todo", updatedAt: new Date(NOW) }),
    ];
    const candidates = deriveNextCandidates(
      rows,
      new Map([["held", overview({ issueId: "held", blocked: true })]]),
      new Map(),
    );
    expect(candidates.map((c) => c.issueId)).toEqual(["ok"]);
  });
});

describe("deriveProjectRollups", () => {
  it("rolls loaded tasks per project with an honest unassigned bucket", () => {
    const rows = [
      issue({ id: "d1", status: "done", projectId: "p1" }),
      issue({ id: "b1", status: "blocked", projectId: "p1" }),
      issue({ id: "t1", status: "todo", projectId: null }),
    ];
    const rollups = deriveProjectRollups(
      rows,
      new Set(["d1"]),
      [{ id: "p1", name: "Atlas", color: "#fff" }],
      new Map(),
    );
    expect(rollups).toHaveLength(2);
    expect(rollups[0]).toMatchObject({ name: "Atlas", delivered: 1, blocked: 1, loaded: 2 });
    expect(rollups[1]).toMatchObject({ name: "No project", loaded: 1 });
  });

  it("counts delivery-projected blocks behind a non-blocked status", () => {
    const rows = [issue({ id: "p", status: "in_progress", projectId: "p1" })];
    const rollups = deriveProjectRollups(
      rows,
      new Set(),
      [{ id: "p1", name: "Atlas", color: null }],
      new Map([["p", overview({ issueId: "p", blocked: true })]]),
    );
    expect(rollups[0]).toMatchObject({ blocked: 1 });
  });
});

describe("describeOperatorInventory", () => {
  it("discloses truncation at the limit and coverage below it", () => {
    expect(describeOperatorInventory(OPERATOR_ISSUE_LOAD_LIMIT, OPERATOR_ISSUE_LOAD_LIMIT).truncated).toBe(true);
    const note = describeOperatorInventory(12, OPERATOR_ISSUE_LOAD_LIMIT);
    expect(note.truncated).toBe(false);
    expect(note.note).toContain("12");
  });
});

describe("decision views", () => {
  function audience(overrides: Partial<AttentionResolverAudience> = {}): AttentionResolverAudience {
    return {
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      effectiveResolverPolicySource: "requested",
      resolverPolicyProvenance: "explicit",
      addresseeAgentId: null,
      addresseeUserId: null,
      addresseeName: null,
      createdByAgentId: null,
      createdByAgentName: null,
      ...overrides,
    };
  }
  it("keeps every row in All", () => {
    const kinds: AttentionItem["sourceKind"][] = [
      "approval",
      "decision",
      "issue_thread_interaction",
      "join_request",
      "recovery_action",
      "productivity_review",
      "blocker_attention",
      "review",
      "failed_run",
      "budget_alert",
      "agent_error_alert",
    ];
    for (const kind of kinds) {
      expect(attentionItemDecisionViews(attentionItem(kind), null).has("all")).toBe(true);
    }
  });

  it("treats verdict gates as human-owned by construction", () => {
    for (const kind of [
      "approval",
      "decision",
      "join_request",
      "productivity_review",
      "budget_alert",
    ] as const) {
      expect(attentionItemDecisionViews(attentionItem(kind), null).has("mine")).toBe(true);
    }
  });

  it("requires ownership evidence for runs, recovery, reviews and blockers", () => {
    // Bare rows carry no evidence: fixing/setup only, never falsely mine.
    expect(attentionItemDecisionViews(attentionItem("failed_run"), null).has("mine")).toBe(false);
    expect(attentionItemDecisionViews(attentionItem("failed_run"), null).has("fixing")).toBe(true);
    expect(attentionItemDecisionViews(attentionItem("recovery_action"), null).has("mine")).toBe(false);
    expect(attentionItemDecisionViews(attentionItem("agent_error_alert"), null).has("mine")).toBe(false);
    expect(attentionItemDecisionViews(attentionItem("agent_error_alert"), null).has("setup")).toBe(true);
    expect(attentionItemDecisionViews(attentionItem("review"), null).has("mine")).toBe(false);
    expect(attentionItemDecisionViews(attentionItem("blocker_attention"), null).has("mine")).toBe(false);
    // Human-owned recovery and human-gated reviews/blocks join the view.
    const ownedRecovery = attentionItem("recovery_action", {
      subject: { ...attentionItem("recovery_action").subject, metadata: { ownerType: "board" } },
    });
    expect(attentionItemDecisionViews(ownedRecovery, null).has("mine")).toBe(true);
    expect(attentionItemDecisionViews(ownedRecovery, null).has("fixing")).toBe(true);
    const humanReview = attentionItem("review", {
      subject: { ...attentionItem("review").subject, metadata: { ownerType: "user", ownerUserId: "user-1" } },
    });
    expect(attentionItemDecisionViews(humanReview, null).has("mine")).toBe(true);
    const humanBlocker = attentionItem("blocker_attention", {
      subject: { ...attentionItem("blocker_attention").subject, metadata: { ownerType: "board" } },
    });
    expect(attentionItemDecisionViews(humanBlocker, null).has("mine")).toBe(true);
    // Explanatory prose never substitutes for recorded ownership.
    const stalledReview = attentionItem("review", {
      entryRule: "human reviewer, user assignee, or linked pending approval",
    });
    expect(attentionItemDecisionViews(stalledReview, null).has("mine")).toBe(false);
  });

  it("routes provisioning to setup alongside the verdict views", () => {
    expect(attentionItemDecisionViews(attentionItem("join_request"), null).has("setup")).toBe(true);
    expect(attentionItemDecisionViews(attentionItem("budget_alert"), null).has("setup")).toBe(true);
    expect(attentionItemDecisionViews(attentionItem("join_request"), null).has("mine")).toBe(true);
    expect(attentionItemDecisionViews(attentionItem("budget_alert"), null).has("mine")).toBe(true);
  });

  it("never hides an item addressed to the viewer, whatever its kind", () => {
    const personal = attentionItem("failed_run", { resolverAudience: audience({ addresseeUserId: "user-1" }) });
    expect(attentionItemDecisionViews(personal, "user-1").has("mine")).toBe(true);
    expect(attentionItemDecisionViews(personal, "user-2").has("mine")).toBe(false);
    expect(attentionItemDecisionViews(personal, "user-1").has("fixing")).toBe(true);
  });

  it("treats human-only policy as the viewer's decision", () => {
    const gated = attentionItem("issue_thread_interaction", {
      resolverAudience: audience({ effectiveResolverPolicy: "human_only" }),
    });
    expect(attentionItemDecisionViews(gated, null).has("mine")).toBe(true);
    const open = attentionItem("issue_thread_interaction", { resolverAudience: audience() });
    expect(attentionItemDecisionViews(open, null).has("mine")).toBe(false);
    expect(attentionItemDecisionViews(open, null).has("all")).toBe(true);
  });

  it("counts and filters consistently, with All as the identity", () => {
    const items = [
      attentionItem("approval"),
      attentionItem("failed_run"),
      attentionItem("join_request"),
      attentionItem("review"),
    ];
    const counts = countDecisionViews(items, null);
    expect(counts.all).toBe(4);
    expect(counts.mine).toBe(2);
    expect(counts.fixing).toBe(1);
    expect(counts.setup).toBe(1);
    expect(filterDecisionView(items, "all", null)).toHaveLength(4);
    for (const view of ["mine", "fixing", "setup"] as const) {
      expect(filterDecisionView(items, view, null)).toHaveLength(counts[view]);
    }
  });

  it("persists the queue view per company with All as the safe default", () => {
    expect(loadOperatorDecisionView("c1")).toBe("all");
    saveOperatorDecisionView("c1", "setup");
    expect(loadOperatorDecisionView("c1")).toBe("setup");
    expect(loadOperatorDecisionView("c2")).toBe("all");
  });
});
