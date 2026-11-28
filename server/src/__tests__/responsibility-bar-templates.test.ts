import { describe, expect, it } from "vitest";
import {
  RESPONSIBILITY_BAR_TEMPLATES,
  RESPONSIBILITY_METRIC_KINDS,
  createResponsibilityBarProposalSchema,
  createResponsibilitySchema,
  proposeResponsibilitySchema,
  resolveResponsibilityMetricKind,
  responsibilityBarMissingForActive,
  responsibilityStatusRule,
  responsibilityTargetLabel,
  updateResponsibilitySchema,
  type ResponsibilityBarMetric,
} from "@paperclipai/shared";
import { buildMetricSummary, buildResponsibilityRollup, buildStatusSentence, type ResponsibilityMetricInput } from "../services/responsibilities.js";
import { buildResponsibilityBarGuidance } from "../services/responsibility-bar-guidance.js";
import { buildPaperclipTaskMarkdown } from "../services/heartbeat/task-markdown.js";

const NOW = new Date("2026-11-13T12:00:00Z");

function metric(overrides: Partial<ResponsibilityMetricInput>): ResponsibilityMetricInput {
  return {
    kind: "volume",
    name: "Investors contacted",
    unit: null,
    target: 20,
    low: null,
    high: null,
    current: 12,
    direction: "at_least",
    updatedAt: NOW,
    ...overrides,
  };
}

function read(overrides: Partial<ResponsibilityMetricInput>) {
  const summary = buildMetricSummary(metric(overrides), NOW);
  const rollup = buildResponsibilityRollup({
    responsibilityId: "r1",
    metric: metric(overrides),
    healthOverride: null,
    counts: { totalTasks: 0, openTasks: 0, blockedTasks: 0, agentTasks: 0, userTasks: 0, doneTasks: 0 },
    work: { projects: [], blockedTasks: [], openByAssignee: [], completedRecently: 0, routines: [] },
    now: NOW,
  });
  return { summary, health: rollup.health, sentence: rollup.statusSentence, attainment: summary?.attainment ?? null, rule: summary?.statusRule ?? null };
}

describe("bar templates: status, attainment and sentences", () => {
  it("keeps volume exactly as before", () => {
    expect(read({})).toMatchObject({ health: "behind", attainment: 0.6, sentence: "12 of 20 investors contacted, 60% of target" });
    expect(read({ current: 15 })).toMatchObject({ health: "at_risk", attainment: 0.75 });
    expect(read({ current: 20 })).toMatchObject({ health: "on_track", attainment: 1 });
    expect(read({ name: "Reply time", unit: "days", target: 2, current: 3, direction: "at_most" }))
      .toMatchObject({ health: "behind", sentence: "Reply time: 3 days against a target of at most 2 days" });
    expect(read({}).rule).toBe("On track at 20 or more; at risk from 15");
    expect(read({ name: "Reply time", unit: "days", target: 2, direction: "at_most" }).rule)
      .toBe("On track at 2 days or less; at risk up to 2.67 days");
    expect(read({ name: "Escalations waiting", target: 0, direction: "at_most", current: 0 }))
      .toMatchObject({ health: "on_track", rule: "On track at 0 or less; behind above that" });
  });

  it("reads a percentage as a share, with whole-number thresholds rounded toward the bar", () => {
    const share = { kind: "percentage", name: "LPs contacted in the last 14 days", unit: "%", target: 90 } as const;
    expect(read({ ...share, current: 90 })).toMatchObject({
      health: "on_track",
      sentence: "LPs contacted in the last 14 days: 90% against a target of at least 90%",
      rule: "On track at 90% or more; at risk from 68%",
    });
    expect(read({ ...share, current: 68 }).health).toBe("at_risk");
    expect(read({ ...share, current: 67 }).health).toBe("behind");
    // A percentage's unit is always %, even when the row has none.
    expect(read({ ...share, unit: null, current: 45 }).sentence).toBe("LPs contacted in the last 14 days: 45% against a target of at least 90%");
    expect(read({ kind: "percentage", name: "Churn", unit: "%", target: 3, current: 4, direction: "at_most" })).toMatchObject({
      health: "at_risk",
      sentence: "Churn: 4% against a target of at most 3%",
      rule: "On track at 3% or less; at risk up to 4%",
    });
    expect(read({ ...share, current: null }).sentence)
      .toBe("Not measured yet: no reading of LPs contacted in the last 14 days against a target of 90%");
  });

  it("treats an existing row whose unit is % as a percentage, and any other legacy row as a volume", () => {
    expect(resolveResponsibilityMetricKind(null, "%")).toBe("percentage");
    expect(resolveResponsibilityMetricKind(null, " % ")).toBe("percentage");
    expect(resolveResponsibilityMetricKind(null, "days")).toBe("volume");
    expect(resolveResponsibilityMetricKind(undefined, null)).toBe("volume");
    expect(resolveResponsibilityMetricKind("bogus", null)).toBe("volume");
    // The pre-template test fixture shape (no kind) reads unchanged.
    const legacy = buildStatusSentence(buildMetricSummary({
      name: "Updates sent on time", unit: "%", target: 100, current: 90, direction: "at_least", updatedAt: NOW,
    }, NOW));
    expect(legacy).toBe("Updates sent on time: 90% against a target of at least 100%");
    expect(buildMetricSummary({ name: "Calls", unit: null, target: 5, current: 2, direction: null, updatedAt: NOW }, NOW))
      .toMatchObject({ kind: "volume", direction: "at_least", low: null, high: null });
  });

  it("reads yes or no: yes is on track, no is behind, never at risk", () => {
    const yesNo = { kind: "yes_no", name: "Board pack sent a week before the meeting", target: null, direction: null } as const;
    expect(read({ ...yesNo, current: 1 })).toMatchObject({
      health: "on_track", attainment: 1, sentence: "Board pack sent a week before the meeting: yes",
      rule: "On track when the answer is yes; behind when it is no",
    });
    expect(read({ ...yesNo, current: 0 })).toMatchObject({
      health: "behind", attainment: 0, sentence: "Board pack sent a week before the meeting: no, the bar is yes",
    });
    expect(read({ ...yesNo, current: null })).toMatchObject({
      health: "not_measured", attainment: null, sentence: "Not measured yet: no yes-or-no reading of board pack sent a week before the meeting",
    });
    // Leftover target or unit on a yes-or-no row do not change how it reads.
    expect(read({ ...yesNo, target: 5, unit: "days", current: 1 }).summary).toMatchObject({ target: null, unit: null, direction: null });
  });

  it("reads a range: inside is on track, a quarter of the width outside is at risk, further out is behind", () => {
    const runway = { kind: "range", name: "Runway", unit: "months", target: null, direction: null, low: 12, high: 24 } as const;
    expect(read({ ...runway, current: 18 })).toMatchObject({
      health: "on_track", attainment: 1, sentence: "Runway: 18 months, inside the range of 12 to 24 months",
      rule: "On track between 12 and 24 months; at risk up to 3 months outside it; behind further out",
    });
    expect(read({ ...runway, current: 12 }).health).toBe("on_track");
    expect(read({ ...runway, current: 24 }).health).toBe("on_track");
    // Width 12, so a quarter is 3: 9 and 27 are the last at-risk readings.
    expect(read({ ...runway, current: 9 })).toMatchObject({
      health: "at_risk", attainment: 0.75, sentence: "Runway: 9 months, 3 months below the range of 12 to 24 months",
    });
    expect(read({ ...runway, current: 27 })).toMatchObject({ health: "at_risk", sentence: "Runway: 27 months, 3 months above the range of 12 to 24 months" });
    expect(read({ ...runway, current: 8.9 }).health).toBe("behind");
    expect(read({ ...runway, current: 40 })).toMatchObject({ health: "behind", attainment: 0 });
    expect(read({ ...runway, current: null }).sentence).toBe("Not measured yet: no reading of runway against a range of 12 to 24 months");
    expect(read({ ...runway, low: null, current: 18 })).toMatchObject({ health: "not_measured", sentence: "Not measured: runway has no range", rule: null });
    expect(read({ kind: "range", name: "Cash in the operating account", unit: "$", low: 50_000, high: 150_000, target: null, direction: null, current: 30_000 }))
      // Width $100,000, so up to $25,000 outside is at risk.
      .toMatchObject({ health: "at_risk", sentence: "Cash in the operating account: $30,000, $20,000 below the range of $50,000 to $150,000" });
  });

  it("labels the target for every template", () => {
    const base = { name: "Runway", unit: "months", direction: null, target: null, low: null, high: null };
    const label = (overrides: Partial<ResponsibilityBarMetric>) => responsibilityTargetLabel({ kind: "volume", ...base, ...overrides });
    expect(label({ kind: "range", low: 12, high: 24 })).toBe("Between 12 and 24 months");
    expect(label({ kind: "yes_no", unit: null })).toBe("Yes");
    expect(label({ kind: "percentage", unit: "%", name: "Share", target: 90, direction: "at_least" })).toBe("At least 90%");
    expect(label({ kind: "volume", name: "Reply time", unit: "days", target: 2, direction: "at_most" })).toBe("At most 2 days");
    expect(label({ kind: "volume", target: null })).toBeNull();
    expect(responsibilityStatusRule({ kind: "range", ...base, low: 24, high: 12 })).toBeNull();
  });

  it("lists what each template needs before it can be active", () => {
    const base = { standard: "Bar", metricName: "Thing" };
    expect(responsibilityBarMissingForActive({ ...base, metricKind: "yes_no" })).toEqual([]);
    expect(responsibilityBarMissingForActive({ ...base, metricKind: "range", metricLow: 1 })).toEqual(["metricHigh"]);
    expect(responsibilityBarMissingForActive({ ...base, metricKind: "percentage" })).toEqual(["metricTarget"]);
    expect(responsibilityBarMissingForActive({ standard: null, metricName: null, metricUnit: "%" })).toEqual(["standard", "metricName", "metricTarget"]);
  });

  it("lets a person's responsibility be active with no metric, but never with half of one", () => {
    const optional = { barOptional: true };
    expect(responsibilityBarMissingForActive({ standard: null, metricName: null }, optional)).toEqual([]);
    // A template, unit or direction left on a row is not a metric.
    expect(responsibilityBarMissingForActive({ standard: "Bar", metricName: null, metricKind: "range", metricUnit: "months" }, optional)).toEqual([]);
    expect(responsibilityBarMissingForActive({ standard: null, metricName: "Calls" }, optional)).toEqual(["standard", "metricTarget"]);
    expect(responsibilityBarMissingForActive({ standard: "Bar", metricName: null, metricTarget: 5 }, optional)).toEqual(["metricName"]);
    expect(responsibilityBarMissingForActive({ standard: "Bar", metricName: null, metricCurrent: 3 }, optional)).toEqual(["metricName", "metricTarget"]);
    expect(responsibilityBarMissingForActive({ standard: "Bar", metricName: "Runway", metricKind: "range", metricLow: 12 }, optional)).toEqual(["metricHigh"]);
    expect(responsibilityBarMissingForActive({ standard: "Bar", metricName: "Calls", metricTarget: 5 }, optional)).toEqual([]);
  });
});

describe("bar templates: validation", () => {
  const create = (body: Record<string, unknown>) => createResponsibilitySchema.safeParse({ title: "Runway", standard: "Bar", metricName: "Runway", ...body });
  const messages = (result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
    (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`);

  it("accepts each template's own fields", () => {
    expect(create({ metricTarget: 20 }).success).toBe(true);
    expect(create({ metricKind: "volume", metricTarget: 2, metricUnit: "days", metricDirection: "at_most" }).success).toBe(true);
    expect(create({ metricKind: "percentage", metricTarget: 90, metricUnit: "%", metricCurrent: 85 }).success).toBe(true);
    expect(create({ metricKind: "yes_no", metricCurrent: true }).success).toBe(true);
    expect(create({ metricKind: "yes_no", metricCurrent: 0 }).success).toBe(true);
    expect(create({ metricKind: "range", metricLow: 12, metricHigh: 24, metricUnit: "months", metricCurrent: 30 }).success).toBe(true);
    // Every template's example is a valid create body and a valid proposal.
    for (const kind of RESPONSIBILITY_METRIC_KINDS) {
      const example = { metricKind: kind, ...RESPONSIBILITY_BAR_TEMPLATES[kind].example };
      expect(createResponsibilitySchema.safeParse({ title: "Example", ...example }).success, kind).toBe(true);
      expect(createResponsibilityBarProposalSchema.safeParse(example).success, kind).toBe(true);
    }
  });

  it("refuses a missing required field with a clear message", () => {
    expect(messages(create({}))).toEqual(["metricTarget: A volume bar needs a target (metricTarget)"]);
    expect(messages(create({ metricKind: "range", metricLow: 12 }))).toEqual(["metricHigh: A range bar needs a high bound (metricHigh)"]);
    expect(messages(create({ metricKind: "percentage" }))).toEqual(["metricTarget: A percentage bar needs a target (metricTarget)"]);
  });

  it("refuses fields the template does not use", () => {
    expect(messages(create({ metricKind: "yes_no", metricTarget: 1 }))).toEqual([
      "metricTarget: A yes-or-no bar has no unit, direction, target or range: yes is on track and no is behind",
    ]);
    expect(messages(create({ metricKind: "range", metricLow: 1, metricHigh: 2, metricDirection: "at_least" }))).toEqual([
      "metricDirection: A range bar has a low and a high bound instead of a target and a direction",
    ]);
    expect(messages(create({ metricKind: "volume", metricTarget: 3, metricLow: 1 }))[0]).toContain("use the range template");
    expect(messages(create({ metricKind: "volume", metricTarget: 3, metricUnit: "%" }))[0]).toContain("percentage template");
    expect(messages(create({ metricKind: "percentage", metricTarget: 50, metricUnit: "points" }))).toEqual(["metricUnit: A percentage bar's unit is always %"]);
  });

  it("refuses values outside the template's rules", () => {
    expect(messages(create({ metricKind: "percentage", metricTarget: 120 }))).toEqual(["metricTarget: A percentage target is a share from 0 to 100"]);
    expect(messages(create({ metricUnit: "%", metricTarget: 90, metricCurrent: 101 }))).toEqual(["metricCurrent: A percentage reading is a share from 0 to 100"]);
    expect(messages(create({ metricKind: "range", metricLow: 24, metricHigh: 12 }))).toEqual([
      "metricHigh: A range's high bound (metricHigh) must be above its low bound (metricLow)",
    ]);
    expect(messages(create({ metricKind: "range", metricLow: 12, metricHigh: 12 }))).toHaveLength(1);
    expect(messages(create({ metricKind: "yes_no", metricCurrent: 2 }))).toEqual(["metricCurrent: A yes-or-no reading is true or false (or 1 or 0)"]);
    expect(messages(create({ metricTarget: 3, metricCurrent: true }))[0]).toContain("only for a yes-or-no bar");
  });

  it("lets a person send only a title, and refuses any half-filled metric", () => {
    const bare = (body: Record<string, unknown>) => createResponsibilitySchema.safeParse({ title: "Token coverage", ...body });
    expect(bare({}).success).toBe(true);
    expect(bare({ standard: "Every screen is built from tokens." }).success).toBe(true);
    expect(bare({ standard: null }).success).toBe(true);
    expect(messages(bare({ metricTarget: 5 }))).toEqual([
      "standard: A responsibility with a metric needs its bar as a sentence (standard)",
      "metricName: A responsibility with a metric needs what is measured (metricName)",
    ]);
    expect(messages(bare({ standard: "Bar", metricName: "Calls" }))).toEqual(["metricTarget: A volume bar needs a target (metricTarget)"]);
    expect(messages(bare({ metricKind: "yes_no" }))).toEqual([
      "standard: A responsibility with a metric needs its bar as a sentence (standard)",
      "metricName: A responsibility with a metric needs what is measured (metricName)",
    ]);
    expect(bare({ metricCurrent: 4 }).success).toBe(false);
    expect(bare({ metricUnit: "days" }).success).toBe(false);
  });

  it("always requires the whole bar from an agent", () => {
    const propose = (body: Record<string, unknown>) => proposeResponsibilitySchema.safeParse({ title: "Pipeline", ownerUserId: "user-1", ...body });
    expect(propose({}).success).toBe(false);
    expect(propose({ standard: "Bar" }).success).toBe(false);
    expect(propose({ standard: "Bar", metricName: "Calls" }).success).toBe(false);
    expect(propose({ standard: "Bar", metricName: "Calls", metricTarget: 5 }).success).toBe(true);
    for (const kind of RESPONSIBILITY_METRIC_KINDS) {
      const example = { metricKind: kind, ...RESPONSIBILITY_BAR_TEMPLATES[kind].example };
      expect(propose(example).success, kind).toBe(true);
    }
  });

  it("lets a patch carry a yes-or-no reading and a template change", () => {
    expect(updateResponsibilitySchema.safeParse({ metricCurrent: false }).success).toBe(true);
    expect(updateResponsibilitySchema.safeParse({ metricKind: "range", metricLow: 1, metricHigh: 3 }).success).toBe(true);
    expect(updateResponsibilitySchema.safeParse({ metricKind: "ratio" }).success).toBe(false);
  });

  it("validates proposals strictly, and asks for evidence with a reading", () => {
    const proposal = (body: Record<string, unknown>) => createResponsibilityBarProposalSchema.safeParse({
      standard: "We always have 12 to 24 months of runway.", metricKind: "range", metricName: "Runway", metricLow: 12, metricHigh: 24, ...body,
    });
    expect(proposal({}).success).toBe(true);
    expect(proposal({ metricKind: undefined }).success).toBe(false);
    expect(messages(proposal({ metricCurrent: 18 }))).toEqual([
      "currentEvidence: Say how you got the reading in currentEvidence, or leave metricCurrent out",
    ]);
    expect(proposal({ metricCurrent: 18, currentEvidence: "Cash over burn" }).success).toBe(true);
    expect(proposal({ metricHigh: undefined }).success).toBe(false);
    expect(proposal({ surprise: true }).success).toBe(false);
  });
});

describe("bar conversation guidance", () => {
  const guidance = buildResponsibilityBarGuidance({
    issueId: "issue-1",
    responsibility: {
      title: "Escalated support",
      description: "First replies to escalated tickets",
      status: "active",
      area: "Customers",
      ownerName: "Dana",
      runByAgentName: "Support lead",
      currentBar: null,
    },
    proposals: [{ standard: "Every escalation gets a reply within a day.", template: "Volume", target: "At most 0", state: "the person said it is not right" }],
  });

  it("gives the facts, every template, what makes a good bar and the exact call", () => {
    for (const text of [
      "conversation with Dana",
      "- Title: Escalated support",
      "- Area: Customers",
      "- Bar today: none yet",
      "the person said it is not right",
      "at most three short questions",
      "Do not ask them to pick a template",
      "Observable",
      "Moves with the work",
      "A level to hold, not a finish line",
      "POST /api/issues/issue-1/bar-proposals",
      "operationId \"POST /api/issues/{id}/bar-proposals\"",
      "You never apply a bar yourself",
      "mark this task done",
    ]) expect(guidance).toContain(text);
    for (const kind of RESPONSIBILITY_METRIC_KINDS) expect(guidance).toContain(`- ${kind} (${RESPONSIBILITY_BAR_TEMPLATES[kind].label})`);
    // The five visualizations by the names the page uses, at most three, fewer when fewer tell the story, droppable on accept.
    for (const text of [
      "- Number (display number)",
      "- Percent (display percent)",
      "- Yes / No (a yes_no bar's own metric)",
      "- Trend (display line)",
      "- Per week (display bar)",
      "A range bar's own metric shows as Trend or Number",
      "Propose at most three visualizations",
      "Prefer fewer when fewer tell the story",
      "may drop any supporting one before accepting",
      "Do not ask them to pick a template or a chart",
    ]) expect(guidance).toContain(text);
    // Every example in the guidance is a valid proposal.
    const examples = guidance.split("\n").filter((line) => line.startsWith("- {")).map((line) => JSON.parse(line.slice(2)));
    expect(examples).toHaveLength(RESPONSIBILITY_METRIC_KINDS.length);
    for (const example of examples) expect(createResponsibilityBarProposalSchema.safeParse(example).success, JSON.stringify(example)).toBe(true);
  });

  it("reaches the task prompt only when the heartbeat passes it", () => {
    const issue = { id: "issue-1", identifier: "PAP-1", title: "Set the bar for Escalated support", status: "todo", priority: "medium" };
    const base = { issue, ancestors: [], wakeComment: null } as unknown as Parameters<typeof buildPaperclipTaskMarkdown>[0];
    expect(buildPaperclipTaskMarkdown(base)).not.toContain("Bar conversation:");
    const withGuidance = buildPaperclipTaskMarkdown({ ...base, responsibilityBarGuidance: guidance });
    expect(withGuidance).toContain("Bar conversation:");
    expect(withGuidance).toContain("POST /api/issues/issue-1/bar-proposals");
  });
});
