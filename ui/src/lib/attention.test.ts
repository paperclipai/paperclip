import { beforeEach, describe, expect, it } from "vitest";
import type { AttentionFeed, AttentionItem, AttentionSourceKind } from "@paperclipai/shared";
import {
  ATTENTION_GROUP_BY_KEY,
  ATTENTION_GROUP_BY_OPTIONS,
  attentionBadgeCount,
  attentionDateBucket,
  attentionDetailLine,
  attentionTone,
  attentionToneStyle,
  buildAttentionFilterOptions,
  countActiveAttentionFilters,
  defaultAttentionFilterState,
  filterAttentionItems,
  groupAttentionItems,
  isInlineResolvable,
  loadAttentionGroupBy,
  NO_GROUP_SENTINEL,
  planAttentionRenderRows,
  saveAttentionGroupBy,
  severityBadge,
  severityStyle,
  sortAttentionItems,
  sourceMeta,
} from "./attention";

function buildItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "a1",
    companyId: "c1",
    sourceKind: "approval",
    subject: { kind: "approval", id: "s1", companyId: "c1", title: "t", identifier: null, status: null, href: null },
    whyNow: "why",
    decisionVerbs: [],
    inlineResolvable: true,
    entryRule: "",
    exitRule: "",
    dedupKey: "d1",
    dismissalKey: "attention:d1",
    severity: "medium",
    rank: 0,
    activityAt: "2026-07-09T12:00:00Z",
    createdAt: "2026-07-09T12:00:00Z",
    updatedAt: "2026-07-09T12:00:00Z",
    relatedIssue: null,
    project: null,
    workspace: null,
    detail: null,
    dismissal: null,
    ...overrides,
    trainingExampleId: overrides.trainingExampleId ?? null,
  };
}

describe("attention group preference persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to None and lists it as the first group option", () => {
    expect(loadAttentionGroupBy()).toBe("none");
    expect(ATTENTION_GROUP_BY_OPTIONS[0]).toEqual(["none", "None"]);
  });

  it("round-trips explicit grouped choices and treats stale values as None", () => {
    saveAttentionGroupBy("date");
    expect(loadAttentionGroupBy()).toBe("date");

    localStorage.setItem(ATTENTION_GROUP_BY_KEY, "unexpected");
    expect(loadAttentionGroupBy()).toBe("none");
  });
});

describe("isInlineResolvable", () => {
  it("is true for approvals/interactions/join when server flags inlineResolvable", () => {
    for (const kind of ["approval", "issue_thread_interaction", "join_request"] as AttentionSourceKind[]) {
      expect(isInlineResolvable(buildItem({ sourceKind: kind, inlineResolvable: true }))).toBe(true);
    }
  });

  it("is false when the server marks a row non-inline (e.g. board approval)", () => {
    expect(isInlineResolvable(buildItem({ sourceKind: "approval", inlineResolvable: false }))).toBe(false);
  });

  it("is never inline for reviews even when flagged", () => {
    expect(isInlineResolvable(buildItem({ sourceKind: "review", inlineResolvable: true }))).toBe(false);
  });

  it("deep-links recovery/failure/budget rows rather than inlining", () => {
    for (const kind of ["recovery_action", "failed_run", "budget_alert", "blocker_attention"] as AttentionSourceKind[]) {
      expect(isInlineResolvable(buildItem({ sourceKind: kind, inlineResolvable: true }))).toBe(false);
    }
  });
});

describe("attentionBadgeCount", () => {
  it("counts every queue row as a decision (mentions/unread never enter the feed)", () => {
    const feed: AttentionFeed = {
      companyId: "c1",
      generatedAt: "2026-07-09T12:00:00Z",
      totalCount: 3,
      countsBySourceKind: {} as AttentionFeed["countsBySourceKind"],
      items: [buildItem({ id: "1" }), buildItem({ id: "2" }), buildItem({ id: "3" })],
    };
    expect(attentionBadgeCount(feed)).toBe(3);
  });

  it("is zero for an empty or missing feed", () => {
    expect(attentionBadgeCount(null)).toBe(0);
    expect(attentionBadgeCount(undefined)).toBe(0);
  });
});

describe("sourceMeta + severityStyle", () => {
  it("labels every catalog source kind", () => {
    const kinds: AttentionSourceKind[] = [
      "approval",
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
      expect(sourceMeta(kind).label.length).toBeGreaterThan(0);
      expect(sourceMeta(kind).icon).toBeTruthy();
    }
  });

  it("maps escalation severity to distinct accents", () => {
    expect(severityStyle("critical").accent).not.toBe(severityStyle("low").accent);
  });
});

describe("attentionTone + attentionToneStyle (canonical color map §4)", () => {
  it("colors plan approvals violet regardless of source kind", () => {
    const fromApproval = buildItem({
      sourceKind: "approval",
      detail: { kind: "plan_approval", issueTitle: "I", planTitle: "P", summaryExcerpt: null, images: [] },
    });
    const fromInteraction = buildItem({
      sourceKind: "issue_thread_interaction",
      detail: { kind: "plan_approval", issueTitle: "I", planTitle: "P", summaryExcerpt: null, images: [] },
    });
    expect(attentionTone(fromApproval)).toBe("violet");
    expect(attentionTone(fromInteraction)).toBe("violet");
    expect(attentionToneStyle(fromApproval).accent).toContain("violet");
  });

  it("colors confirmations / questions / verdicts in the sky family", () => {
    expect(attentionTone(buildItem({ sourceKind: "approval" }))).toBe("sky");
    expect(attentionTone(buildItem({ sourceKind: "issue_thread_interaction" }))).toBe("sky");
    expect(
      attentionTone(
        buildItem({
          sourceKind: "issue_thread_interaction",
          detail: { kind: "questions", questionCount: 2, firstQuestionText: "?", images: [] },
        }),
      ),
    ).toBe("sky");
  });

  it("colors failures rose and blocked/recovery/budget amber", () => {
    expect(attentionTone(buildItem({ sourceKind: "failed_run" }))).toBe("rose");
    expect(attentionTone(buildItem({ sourceKind: "agent_error_alert" }))).toBe("rose");
    expect(attentionTone(buildItem({ sourceKind: "blocker_attention" }))).toBe("amber");
    expect(attentionTone(buildItem({ sourceKind: "recovery_action" }))).toBe("amber");
    expect(attentionTone(buildItem({ sourceKind: "budget_alert" }))).toBe("amber");
  });

  it("colors join requests neutral", () => {
    expect(attentionTone(buildItem({ sourceKind: "join_request" }))).toBe("neutral");
  });

  it("gives every tone a distinct accent and never keys color off severity", () => {
    const rose = buildItem({ sourceKind: "failed_run", severity: "low" });
    const amber = buildItem({ sourceKind: "budget_alert", severity: "critical" });
    // Same-source rows with opposite severities share one accent (color ≠ severity).
    expect(attentionToneStyle(buildItem({ sourceKind: "failed_run", severity: "critical" })).accent).toBe(
      attentionToneStyle(rose).accent,
    );
    expect(attentionToneStyle(rose).accent).not.toBe(attentionToneStyle(amber).accent);
  });
});

describe("severityBadge", () => {
  it("only surfaces a badge for Critical/High", () => {
    expect(severityBadge("critical")?.label).toBe("Critical");
    expect(severityBadge("high")?.label).toBe("High");
    expect(severityBadge("medium")).toBeNull();
    expect(severityBadge("low")).toBeNull();
  });
});

describe("attentionDetailLine (§7)", () => {
  it("summarizes questions with a count and the first question", () => {
    const line = attentionDetailLine(
      buildItem({
        detail: { kind: "questions", questionCount: 2, firstQuestionText: "Which auth provider?", images: [] },
      }),
    );
    expect(line).toContain("2 questions");
    expect(line).toContain("Which auth provider?");
  });

  it("singularizes a single suggested task", () => {
    const line = attentionDetailLine(
      buildItem({
        detail: { kind: "suggested_tasks", taskCount: 1, firstTaskTitle: "Add index", images: [] },
      }),
    );
    expect(line).toContain("1 suggested task");
    expect(line).not.toContain("tasks");
  });

  it("renders a failed run as agent — reason", () => {
    const line = attentionDetailLine(
      buildItem({
        sourceKind: "failed_run",
        detail: { kind: "failed_run", agentName: "Deployer", failureReasonExcerpt: "exit code 1", images: [] },
      }),
    );
    expect(line).toContain("Deployer");
    expect(line).toContain("exit code 1");
  });

  it("returns null when there is no detail block", () => {
    expect(attentionDetailLine(buildItem({ detail: null }))).toBeNull();
  });
});

describe("sortAttentionItems", () => {
  const older = buildItem({ id: "old", activityAt: "2026-07-01T00:00:00Z", rank: 5 });
  const newer = buildItem({ id: "new", activityAt: "2026-07-09T00:00:00Z", rank: 9 });

  it("puts newest first by default", () => {
    expect(sortAttentionItems([older, newer], "newest").map((i) => i.id)).toEqual(["new", "old"]);
  });

  it("reverses to oldest first", () => {
    expect(sortAttentionItems([older, newer], "oldest").map((i) => i.id)).toEqual(["old", "new"]);
  });

  it("breaks activity ties by rank (lower rank wins) regardless of order", () => {
    const a = buildItem({ id: "a", activityAt: "2026-07-09T00:00:00Z", rank: 2 });
    const b = buildItem({ id: "b", activityAt: "2026-07-09T00:00:00Z", rank: 1 });
    expect(sortAttentionItems([a, b], "newest").map((i) => i.id)).toEqual(["b", "a"]);
    expect(sortAttentionItems([a, b], "oldest").map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the input array", () => {
    const input = [older, newer];
    sortAttentionItems(input, "newest");
    expect(input.map((i) => i.id)).toEqual(["old", "new"]);
  });
});

describe("attentionDateBucket", () => {
  const now = new Date("2026-07-10T12:00:00Z").getTime();

  it("buckets by rolling calendar-day windows relative to now", () => {
    expect(attentionDateBucket("2026-07-10T09:00:00Z", now)).toBe("today");
    expect(attentionDateBucket("2026-07-09T23:00:00Z", now)).toBe("yesterday");
    expect(attentionDateBucket("2026-07-06T09:00:00Z", now)).toBe("this_week");
    expect(attentionDateBucket("2026-06-01T09:00:00Z", now)).toBe("earlier");
  });

  it("treats invalid timestamps as earlier", () => {
    expect(attentionDateBucket("not-a-date", now)).toBe("earlier");
  });
});

describe("groupAttentionItems", () => {
  const now = new Date("2026-07-10T12:00:00Z").getTime();

  it("leaves None as one unlabeled group that preserves caller sort order", () => {
    const items = sortAttentionItems(
      [
        buildItem({ id: "old", activityAt: "2026-07-10T08:00:00Z" }),
        buildItem({ id: "new", activityAt: "2026-07-10T10:00:00Z" }),
      ],
      "newest",
    );
    const groups = groupAttentionItems(items, "none", { now });
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBeNull();
    expect(groups[0].items.map((i) => i.id)).toEqual(["new", "old"]);
  });

  it("groups by date into fixed Today/Yesterday/This week/Earlier order", () => {
    const items = [
      buildItem({ id: "earlier", activityAt: "2026-06-01T00:00:00Z" }),
      buildItem({ id: "today", activityAt: "2026-07-10T08:00:00Z" }),
      buildItem({ id: "yesterday", activityAt: "2026-07-09T08:00:00Z" }),
    ];
    const groups = groupAttentionItems(items, "date", { now });
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Earlier"]);
    expect(groups.map((g) => g.key)).toEqual(["date:today", "date:yesterday", "date:earlier"]);
  });

  it("groups by severity in escalation order regardless of input order", () => {
    const items = [
      buildItem({ id: "low", severity: "low" }),
      buildItem({ id: "crit", severity: "critical" }),
      buildItem({ id: "med", severity: "medium" }),
    ];
    const groups = groupAttentionItems(items, "severity");
    expect(groups.map((g) => g.label)).toEqual(["Critical", "Medium", "Low"]);
  });

  it("groups by project, keeping a 'No project' bucket for unassigned rows", () => {
    const items = [
      buildItem({ id: "p1", activityAt: "2026-07-10T10:00:00Z", project: { id: "proj-1", name: "Alpha", urlKey: "alpha", color: null, icon: null } }),
      buildItem({ id: "none", activityAt: "2026-07-10T11:00:00Z", project: null }),
    ];
    const groups = groupAttentionItems(items, "project");
    const noneGroup = groups.find((g) => g.key === `project:${NO_GROUP_SENTINEL}`);
    expect(noneGroup?.label).toBe("No project");
    expect(groups.find((g) => g.key === "project:proj-1")?.label).toBe("Alpha");
    // Freshest group floats first (No project row is newer).
    expect(groups[0].key).toBe(`project:${NO_GROUP_SENTINEL}`);
  });

  it("groups by type using source labels", () => {
    const items = [
      buildItem({ id: "a", sourceKind: "approval" }),
      buildItem({ id: "j", sourceKind: "join_request" }),
    ];
    const groups = groupAttentionItems(items, "type");
    expect(groups.map((g) => g.key).sort()).toEqual(["type:approval", "type:join_request"]);
  });

  it("preserves the caller-provided intra-group order (sort governs within a bucket)", () => {
    const items = sortAttentionItems(
      [
        buildItem({ id: "t1", activityAt: "2026-07-10T08:00:00Z" }),
        buildItem({ id: "t2", activityAt: "2026-07-10T10:00:00Z" }),
      ],
      "newest",
    );
    const [today] = groupAttentionItems(items, "date", { now });
    expect(today.items.map((i) => i.id)).toEqual(["t2", "t1"]);
  });

  it("returns no groups for an empty list", () => {
    expect(groupAttentionItems([], "date", { now })).toEqual([]);
  });
});

describe("filterAttentionItems", () => {
  const approval = buildItem({ id: "ap", sourceKind: "approval", severity: "high", project: { id: "p1", name: "Alpha", urlKey: "a", color: null, icon: null } });
  const join = buildItem({ id: "jn", sourceKind: "join_request", severity: "low", project: null });
  const items = [approval, join];

  it("returns everything when no filters are active", () => {
    expect(filterAttentionItems(items, defaultAttentionFilterState)).toHaveLength(2);
    expect(countActiveAttentionFilters(defaultAttentionFilterState)).toBe(0);
  });

  it("filters by source kind", () => {
    const result = filterAttentionItems(items, { ...defaultAttentionFilterState, sourceKinds: ["approval"] });
    expect(result.map((i) => i.id)).toEqual(["ap"]);
  });

  it("filters by severity", () => {
    const result = filterAttentionItems(items, { ...defaultAttentionFilterState, severities: ["low"] });
    expect(result.map((i) => i.id)).toEqual(["jn"]);
  });

  it("filters by project id and the no-project sentinel", () => {
    expect(filterAttentionItems(items, { ...defaultAttentionFilterState, projectIds: ["p1"] }).map((i) => i.id)).toEqual(["ap"]);
    expect(
      filterAttentionItems(items, { ...defaultAttentionFilterState, projectIds: [NO_GROUP_SENTINEL] }).map((i) => i.id),
    ).toEqual(["jn"]);
  });

  it("ANDs across dimensions", () => {
    const result = filterAttentionItems(items, {
      ...defaultAttentionFilterState,
      sourceKinds: ["approval"],
      severities: ["low"],
    });
    expect(result).toHaveLength(0);
  });
});

describe("buildAttentionFilterOptions", () => {
  it("collects the distinct dimensions present in the feed", () => {
    const items = [
      buildItem({ sourceKind: "approval", severity: "high", project: { id: "p1", name: "Alpha", urlKey: "a", color: null, icon: null }, workspace: { id: "w1", name: "WS" } }),
      buildItem({ sourceKind: "join_request", severity: "low", project: null, workspace: null }),
    ];
    const options = buildAttentionFilterOptions(items);
    expect(options.sourceKinds.sort()).toEqual(["approval", "join_request"]);
    expect(options.severities).toEqual(["high", "low"]);
    expect(options.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(options.workspaces.map((w) => w.id)).toEqual(["w1"]);
    expect(options.hasNoProject).toBe(true);
    expect(options.hasNoWorkspace).toBe(true);
  });
});

describe("planAttentionRenderRows (PAP-13784 incremental rendering)", () => {
  const items = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => buildItem({ id: `${prefix}${i}` }));

  it("allocates the budget across groups in document order", () => {
    const plan = planAttentionRenderRows({
      groups: [
        { key: "g1", label: "One", items: items("a", 3) },
        { key: "g2", label: "Two", items: items("b", 3) },
      ],
      collapsedGroupKeys: new Set(),
      snoozedItems: [],
      snoozedOpen: false,
      dismissedItems: [],
      dismissedOpen: false,
      limit: 4,
    });
    expect(plan.groupRows.get("g1")).toHaveLength(3);
    expect(plan.groupRows.get("g2")).toHaveLength(1);
    expect(plan.hasMoreRows).toBe(true);
  });

  it("renders everything and reports no more rows when the budget covers the feed", () => {
    const plan = planAttentionRenderRows({
      groups: [{ key: "g1", label: null, items: items("a", 5) }],
      collapsedGroupKeys: new Set(),
      snoozedItems: items("s", 2),
      snoozedOpen: true,
      dismissedItems: items("d", 2),
      dismissedOpen: true,
      limit: 9,
    });
    expect(plan.groupRows.get("g1")).toHaveLength(5);
    expect(plan.snoozedRows).toHaveLength(2);
    expect(plan.dismissedRows).toHaveLength(2);
    expect(plan.hasMoreRows).toBe(false);
  });

  it("collapsed groups and closed curtains consume no budget and never truncate", () => {
    const plan = planAttentionRenderRows({
      groups: [
        { key: "g1", label: "One", items: items("a", 50) },
        { key: "g2", label: "Two", items: items("b", 2) },
      ],
      collapsedGroupKeys: new Set(["g1"]),
      snoozedItems: items("s", 50),
      snoozedOpen: false,
      dismissedItems: [],
      dismissedOpen: false,
      limit: 2,
    });
    expect(plan.groupRows.get("g1")).toHaveLength(0);
    expect(plan.groupRows.get("g2")).toHaveLength(2);
    expect(plan.snoozedRows).toHaveLength(0);
    expect(plan.hasMoreRows).toBe(false);
  });

  it("curtains draw from the same budget after the active groups", () => {
    const plan = planAttentionRenderRows({
      groups: [{ key: "g1", label: null, items: items("a", 3) }],
      collapsedGroupKeys: new Set(),
      snoozedItems: items("s", 5),
      snoozedOpen: true,
      dismissedItems: items("d", 5),
      dismissedOpen: true,
      limit: 5,
    });
    expect(plan.groupRows.get("g1")).toHaveLength(3);
    expect(plan.snoozedRows).toHaveLength(2);
    expect(plan.dismissedRows).toHaveLength(0);
    expect(plan.hasMoreRows).toBe(true);
  });
});
