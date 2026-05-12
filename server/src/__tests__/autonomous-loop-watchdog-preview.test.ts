import { describe, expect, it, vi } from "vitest";
import {
  buildAutonomousGoalLoopWatchdogPreview,
  encodeAutonomousGoalLoopWatchdogCursor,
  isValidAutonomousGoalLoopWatchdogCursor,
  listAutonomousGoalLoopWatchdogPreview,
  parseAutonomousGoalLoopWatchdogCursor,
} from "../services/autonomous-loop-watchdog-preview.ts";

const baseIssue = {
  id: "00000000-0000-4000-8000-000000000001",
  companyId: "company-1",
  projectId: "project-1",
  goalId: "goal-1",
  title: "Ship autonomous creator traffic ops workflow",
  priority: "high",
  status: "in_progress",
  assigneeAgentId: "agent-ceo",
  assigneeUserId: null,
  requestDepth: 0,
  executionPolicy: {
    missionControl: {
      enabled: true,
      riskClass: "high",
      requiredDocumentKeys: ["validation-contract", "worker-handoff", "validator-report"],
      acceptedValidatorVerdicts: ["PASS"],
      liveActionGate: "board",
      destructiveActionGate: "board",
      autonomousLoop: {
        enabled: true,
        controller: "CEO",
        goal: "Ship autonomous creator traffic ops workflow",
        startedAt: "2026-05-11T08:00:00.000Z",
        iteration: 2,
        maxIterations: 5,
        maxRuntimeHours: 24,
        maxDecisionAgeMinutes: 30,
      },
    },
  },
};

function docsWithDecision(decision: Record<string, unknown>, updatedAt = "2026-05-11T09:45:00.000Z") {
  return [
    { key: "validation-contract", body: "objective/pass criteria" },
    { key: "worker-handoff", body: "completed/checks" },
    { key: "validator-report", body: "Verdict: PASS" },
    { key: "ceo-loop-decision", body: JSON.stringify(decision), updatedAt },
  ];
}

function staleDecision(iteration = 2) {
  return {
    version: 1,
    iteration,
    decision: "next_iteration",
    decisionWrittenAt: "2026-05-11T09:00:00.000Z",
    rationale: "Continue with a safe internal task.",
    nextTask: {
      title: "Repair preview",
      acceptanceCriteria: ["Preview shows repair candidate"],
      safeToRunWithoutUserApproval: true,
    },
    evidence: ["validator-report PASS"],
  };
}

function watchdogIssue(overrides: Partial<typeof baseIssue> & { id: string; title?: string }) {
  return {
    ...baseIssue,
    title: overrides.title ?? baseIssue.title,
    identifier: null,
    createdAt: "2026-05-11T08:00:00.000Z",
    updatedAt: "2026-05-11T09:00:00.000Z",
    ...overrides,
  };
}

function createDbMock(selectResults: unknown[][], executeResult: unknown = []) {
  const leftJoinCalls: unknown[][] = [];
  const whereCalls: unknown[][] = [];
  const orderByCalls: unknown[][] = [];
  const limitCalls: number[] = [];
  const executeCalls: unknown[] = [];
  let selectIndex = 0;
  const select = vi.fn(() => {
    const result = selectResults[selectIndex] ?? [];
    selectIndex += 1;
    const chain = {
      from: vi.fn(() => chain),
      leftJoin: vi.fn((...args: unknown[]) => {
        leftJoinCalls.push(args);
        return chain;
      }),
      innerJoin: vi.fn(() => chain),
      where: vi.fn((...args: unknown[]) => {
        whereCalls.push(args);
        return chain;
      }),
      orderBy: vi.fn((...args: unknown[]) => {
        orderByCalls.push(args);
        return chain;
      }),
      as: vi.fn(() => chain),
      limit: vi.fn((value: number) => {
        limitCalls.push(value);
        return chain;
      }),
      then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return chain;
  });
  const execute = vi.fn(async (query: unknown) => {
    executeCalls.push(query);
    return executeResult;
  });

  return {
    db: { select, execute },
    select,
    execute,
    executeCalls,
    leftJoinCalls,
    whereCalls,
    orderByCalls,
    limitCalls,
  };
}

function sqlText(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sqlText(item, seen)).join(" ");
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.queryChunks)) return sqlText(record.queryChunks, seen);
  if (Array.isArray(record.value)) return sqlText(record.value, seen);
  return Object.values(record).map((item) => sqlText(item, seen)).join(" ");
}

function opaqueCursorPayload(payload: Record<string, unknown>) {
  return `wdog_cursor_${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

describe("autonomous loop watchdog preview", () => {
  it("surfaces stale CEO decisions as operator-owned repair candidates", () => {
    const preview = buildAutonomousGoalLoopWatchdogPreview({
      companyId: "company-1",
      generatedAt: "2026-05-11T10:30:00.000Z",
      issues: [
        {
          issue: baseIssue,
          documents: docsWithDecision(
            {
              version: 1,
              iteration: 2,
              decision: "next_iteration",
              decisionWrittenAt: "2026-05-11T09:00:00.000Z",
              rationale: "Continue with a safe internal task.",
              nextTask: {
                title: "Repair preview",
                acceptanceCriteria: ["Preview shows repair candidate"],
                safeToRunWithoutUserApproval: true,
              },
              evidence: ["validator-report PASS"],
            },
            "2026-05-11T09:00:00.000Z",
          ),
        },
      ],
    });

    expect(preview).toMatchObject({
      companyId: "company-1",
      mode: "preview",
      readOnly: true,
      generatedAt: "2026-05-11T10:30:00.000Z",
      totalIssuesScanned: 1,
    });
    expect(preview.candidates).toEqual([
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000001:repair_loop_decision:ceo_loop_decision_stale",
        kind: "loop_decision_repair",
        severity: "high",
        owner: "operator",
        issueId: "00000000-0000-4000-8000-000000000001",
        reason: "ceo_loop_decision_stale",
        recoveryAction: "repair_loop_decision",
        userVisible: false,
      }),
    ]);
    expect(preview.candidates[0]).not.toHaveProperty("metricKey");
    expect(preview.candidates[0]?.recommendedAction).toContain("ceo-loop-decision");
  });

  it("does not launder user approval requests into operator repair candidates", () => {
    const preview = buildAutonomousGoalLoopWatchdogPreview({
      companyId: "company-1",
      generatedAt: "2026-05-11T10:00:00.000Z",
      issues: [
        {
          issue: baseIssue,
          documents: docsWithDecision({
            version: 1,
            iteration: 2,
            decision: "approval_required",
            rationale: "Production deploy needs explicit user approval.",
            hardGate: {
              required: true,
              reason: "Production deploy",
              category: "production_deploy",
            },
            evidence: ["deploy requested"],
          }),
        },
      ],
    });

    expect(preview.candidates).toEqual([]);
  });

  it("surfaces missing CEO loop decisions as operator manual-review candidates", () => {
    const preview = buildAutonomousGoalLoopWatchdogPreview({
      companyId: "company-1",
      generatedAt: "2026-05-11T10:00:00.000Z",
      issues: [
        {
          issue: baseIssue,
          documents: [
            { key: "validation-contract", body: "objective/pass criteria" },
            { key: "worker-handoff", body: "completed/checks" },
            { key: "validator-report", body: "Verdict: PASS" },
          ],
        },
      ],
    });

    expect(preview.candidates).toEqual([
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000001:manual_review:missing_ceo_loop_decision",
        kind: "loop_manual_review",
        severity: "medium",
        owner: "operator",
        reason: "missing_ceo_loop_decision",
        recoveryAction: "manual_review",
        userVisible: false,
      }),
    ]);
    expect(preview.candidates[0]).not.toHaveProperty("metricKey");
  });

  it("orders stale decision repair candidates by oldest CEO decision first", () => {
    const preview = buildAutonomousGoalLoopWatchdogPreview({
      companyId: "company-1",
      generatedAt: "2026-05-11T11:00:00.000Z",
      issues: [
        {
          issue: watchdogIssue({ id: "00000000-0000-4000-8000-000000000010", title: "Alpha newer decision" }),
          documents: docsWithDecision(staleDecision(), "2026-05-11T09:45:00.000Z"),
        },
        {
          issue: watchdogIssue({ id: "00000000-0000-4000-8000-000000000011", title: "Zulu older decision" }),
          documents: docsWithDecision(staleDecision(), "2026-05-11T08:00:00.000Z"),
        },
      ],
    });

    expect(preview.candidates.map((candidate) => candidate.issueId)).toEqual(["00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000010"]);
  });

  it("uses batched document and child queries when listing watchdog previews", async () => {
    const issueRows = [
      watchdogIssue({ id: "00000000-0000-4000-8000-000000000101", title: "First stale loop" }),
      watchdogIssue({ id: "00000000-0000-4000-8000-000000000102", title: "Second stale loop" }),
    ];
    const documentRows = issueRows.flatMap((issue, index) =>
      docsWithDecision(staleDecision(), index === 0 ? "2026-05-11T08:00:00.000Z" : "2026-05-11T08:30:00.000Z")
        .map((document) => ({ ...document, issueId: issue.id })),
    );
    const { db, select, execute, limitCalls } = createDbMock([issueRows, documentRows]);

    const preview = await listAutonomousGoalLoopWatchdogPreview(db as never, "company-1", { limit: 2 });

    expect(select).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(limitCalls[0]).toBe(3);
    expect(limitCalls).not.toContain(100 * issueRows.length);
    expect(preview.totalIssuesScanned).toBe(2);
    expect(preview.candidates).toHaveLength(2);
  });

  it("uses per-parent continuation child rank SQL instead of a global child limit", async () => {
    const issueRows = [
      watchdogIssue({ id: "00000000-0000-4000-8000-000000000201", title: "Parent A stale loop" }),
      watchdogIssue({ id: "00000000-0000-4000-8000-000000000202", title: "Parent B stale loop" }),
    ];
    const documentRows = issueRows.flatMap((issue, index) =>
      docsWithDecision(staleDecision(), index === 0 ? "2026-05-11T08:00:00.000Z" : "2026-05-11T08:30:00.000Z")
        .map((document) => ({ ...document, issueId: issue.id })),
    );
    const { db, executeCalls, limitCalls } = createDbMock([issueRows, documentRows]);

    await listAutonomousGoalLoopWatchdogPreview(db as never, "company-1", { limit: 2 });

    expect(limitCalls).not.toContain(100 * issueRows.length);
    expect(executeCalls).toHaveLength(1);
    const childSql = sqlText(executeCalls[0]).replace(/\s+/g, " ").toLowerCase();
    expect(childSql).toContain("row_number() over");
    expect(childSql).toContain("partition by child.parent_id");
    expect(childSql).toContain("child_rank <=");
    expect(childSql).toContain("order by ranked.parent_id asc");
  });

  it("returns cursor metadata without scanning the lookahead issue", async () => {
    const issueRows = [
      {
        ...watchdogIssue({ id: "00000000-0000-4000-8000-000000000101", title: "First stale loop" }),
        decisionUpdatedAt: "2026-05-11T08:00:00.000Z",
      },
      {
        ...watchdogIssue({ id: "00000000-0000-4000-8000-000000000102", title: "Second stale loop" }),
        decisionUpdatedAt: "2026-05-11T08:30:00.000Z",
      },
      {
        ...watchdogIssue({ id: "00000000-0000-4000-8000-000000000103", title: "Lookahead stale loop" }),
        decisionUpdatedAt: "2026-05-11T09:00:00.000Z",
      },
    ];
    const documentRows = issueRows.slice(0, 2).flatMap((issue, index) =>
      docsWithDecision(staleDecision(), index === 0 ? "2026-05-11T08:00:00.000Z" : "2026-05-11T08:30:00.000Z")
        .map((document) => ({ ...document, issueId: issue.id })),
    );
    const { db } = createDbMock([issueRows, documentRows]);

    const preview = await listAutonomousGoalLoopWatchdogPreview(db as never, "company-1", { limit: 2 });

    expect(preview.totalIssuesScanned).toBe(2);
    expect(preview.hasMore).toBe(true);
    expect(preview.nextCursor).toEqual(expect.any(String));
    expect(preview.nextCursor).not.toBe("00000000-0000-4000-8000-000000000102");
    expect(parseAutonomousGoalLoopWatchdogCursor(preview.nextCursor!)).toMatchObject({
      decisionMissingSort: 0,
      decisionUpdatedAt: "2026-05-11T08:30:00.000Z",
      issueUpdatedAt: "2026-05-11T09:00:00.000Z",
      issueId: "00000000-0000-4000-8000-000000000102",
    });
    expect(preview.candidates.map((candidate) => candidate.issueId)).toEqual(["00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000102"]);
  });

  it("uses opaque cursor tuples without refetching the cursor issue", async () => {
    const cursor = encodeAutonomousGoalLoopWatchdogCursor({
      decisionMissingSort: 0,
      decisionUpdatedAt: "2026-05-11T08:30:00.000Z",
      issueUpdatedAt: "2026-05-11T09:00:00.000Z",
      issueId: "00000000-0000-4000-8000-000000000102",
    });
    const issueRows = [
      {
        ...watchdogIssue({ id: "00000000-0000-4000-8000-000000000103", title: "Third stale loop" }),
        decisionUpdatedAt: "2026-05-11T09:00:00.000Z",
      },
    ];
    const documentRows = docsWithDecision(staleDecision(), "2026-05-11T09:00:00.000Z")
      .map((document) => ({ ...document, issueId: "00000000-0000-4000-8000-000000000103" }));
    const { db, limitCalls } = createDbMock([issueRows, documentRows]);

    const preview = await listAutonomousGoalLoopWatchdogPreview(db as never, "company-1", { limit: 2, cursor });

    expect(limitCalls[0]).toBe(3);
    expect(preview.candidates.map((candidate) => candidate.issueId)).toEqual(["00000000-0000-4000-8000-000000000103"]);
  });

  it("uses the same millisecond timestamp expression for ordering and cursor predicates", async () => {
    const cursor = encodeAutonomousGoalLoopWatchdogCursor({
      decisionMissingSort: 0,
      decisionUpdatedAt: "2026-05-11T08:30:00.123Z",
      issueUpdatedAt: "2026-05-11T09:00:00.456Z",
      issueId: "00000000-0000-4000-8000-000000000102",
    });
    const { db, orderByCalls, whereCalls } = createDbMock([[]]);

    await listAutonomousGoalLoopWatchdogPreview(db as never, "company-1", { limit: 2, cursor });

    const orderSql = sqlText(orderByCalls).replace(/\s+/g, " ").toLowerCase();
    const whereSql = sqlText(whereCalls).replace(/\s+/g, " ").toLowerCase();
    expect(orderSql).toContain("date_trunc");
    expect(orderSql).toContain("milliseconds");
    expect(whereSql).toContain("date_trunc");
    expect(whereSql).toContain("milliseconds");
  });

  it("scopes the main decision document join by document company", async () => {
    const { db, leftJoinCalls } = createDbMock([[]]);

    await listAutonomousGoalLoopWatchdogPreview(db as never, "company-1", { limit: 2 });

    expect(leftJoinCalls).toHaveLength(2);
    const documentJoinSql = sqlText(leftJoinCalls[1]).replace(/\s+/g, " ").toLowerCase();
    expect(documentJoinSql).toContain("company");
    expect(documentJoinSql).toContain("company-1");
  });

  it("rejects malformed watchdog cursors before querying", async () => {
    const { db, select } = createDbMock([]);

    await expect(
      listAutonomousGoalLoopWatchdogPreview(db as never, "company-1", { limit: 2, cursor: "00000000-0000-4000-8000-000000000102" }),
    ).rejects.toThrow("Invalid autonomous loop watchdog cursor");
    expect(select).not.toHaveBeenCalled();
  });

  it("rejects structured malformed opaque watchdog cursors", async () => {
    const basePayload = {
      version: 1,
      decisionMissingSort: 0,
      decisionUpdatedAt: "2026-05-11T08:30:00.000Z",
      issueUpdatedAt: "2026-05-11T09:00:00.000Z",
      issueId: "00000000-0000-4000-8000-000000000102",
    };
    const cursors = [
      opaqueCursorPayload({ ...basePayload, issueId: "not-a-uuid" }),
      opaqueCursorPayload({ ...basePayload, issueUpdatedAt: null }),
      opaqueCursorPayload({ ...basePayload, issueUpdatedAt: "not-a-date" }),
      opaqueCursorPayload({ ...basePayload, decisionUpdatedAt: null }),
      opaqueCursorPayload({ ...basePayload, decisionMissingSort: 1, decisionUpdatedAt: "2026-05-11T08:30:00.000Z" }),
      opaqueCursorPayload({ ...basePayload, decisionMissingSort: 1, decisionUpdatedAt: undefined }),
    ];

    for (const cursor of cursors) {
      expect(isValidAutonomousGoalLoopWatchdogCursor(cursor)).toBe(false);
      expect(() => parseAutonomousGoalLoopWatchdogCursor(cursor)).toThrow("Invalid autonomous loop watchdog cursor");
      const { db, select } = createDbMock([]);
      await expect(listAutonomousGoalLoopWatchdogPreview(db as never, "company-1", { limit: 2, cursor })).rejects.toThrow(
        "Invalid autonomous loop watchdog cursor",
      );
      expect(select).not.toHaveBeenCalled();
    }
  });
});
