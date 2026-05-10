import { describe, it, expect, vi } from "vitest";

import {
  scanEngineerUtilization,
  DEFAULT_CONFIG,
  type EngineerIssueSet,
  type IssueSnapshot,
} from "./horizon-scan.js";
import {
  executeActions,
  createInMemoryDedupStore,
  type ActionApiClient,
  type ExecutorContext,
} from "./horizon-scan-actions.js";

// ────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────

const NOW = new Date("2026-05-10T12:00:00Z");

function iso(hoursAgo: number): string {
  return new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function makeIssue(
  id: string,
  status: string,
  updatedHoursAgo: number,
): IssueSnapshot {
  return { id, status, priority: "high", updatedAt: iso(updatedHoursAgo) };
}

function makeMockApi(): { api: ActionApiClient; calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    postComment: [],
    createChildIssue: [],
    sendFeishuDM: [],
  };
  const api: ActionApiClient = {
    postComment: vi.fn(async (issueId, body) => {
      calls["postComment"]!.push([issueId, body]);
    }),
    createChildIssue: vi.fn(async (params) => {
      calls["createChildIssue"]!.push([params]);
      return "new-child-id";
    }),
    sendFeishuDM: vi.fn(async (msg) => {
      calls["sendFeishuDM"]!.push([msg]);
    }),
  };
  return { api, calls };
}

function makeCtx(api: ActionApiClient, overrides: Partial<ExecutorContext> = {}): ExecutorContext {
  return {
    companyId: "company-1",
    ctoAgentId: "cto-agent-1",
    goalId: "goal-1",
    dedup: createInMemoryDedupStore(),
    api,
    now: NOW,
    ...overrides,
  };
}

const singleEngineer: EngineerIssueSet = {
  agentId: "eng-1",
  name: "后端工程师",
  issues: [],
};

// ────────────────────────────────────────────────
// Test 1: LEVEL-1 — single issue stalled 25h → [URGENT] comment, NO Feishu DM
// ────────────────────────────────────────────────

describe("test_level1_stall_24h_triggers_urgent_comment_and_mention_wake", () => {
  it("detects ENGINEER_ISSUE_STALLED_24H and posts comment, no Feishu DM", async () => {
    const engineer: EngineerIssueSet = {
      ...singleEngineer,
      issues: [makeIssue("issue-1", "in_progress", 25)],
    };

    const scanResult = scanEngineerUtilization([engineer], DEFAULT_CONFIG, NOW);
    const anomalies = scanResult.engineers[0]!.anomalies;

    expect(anomalies.map((a) => a.type)).toContain("ENGINEER_ISSUE_STALLED_24H");

    const { api, calls } = makeMockApi();
    await executeActions(anomalies, makeCtx(api));

    expect(calls["postComment"]!.length).toBe(1);
    expect(calls["postComment"]![0]![1] as string).toMatch(/\[URGENT\]/);
    expect(calls["postComment"]![0]![1] as string).toContain("eng-1");
    expect(calls["sendFeishuDM"]!.length).toBe(0);
    expect(calls["createChildIssue"]!.length).toBe(0);
  });
});

// ────────────────────────────────────────────────
// Test 2: LEVEL-2 — ALL issues stalled >= 48h → Feishu DM + CTO child issue
// ────────────────────────────────────────────────

describe("test_level2_all_stalled_48h_escalates_to_ceo", () => {
  it("detects ENGINEER_ALL_STALLED_48H, sends Feishu DM and creates CTO child issue", async () => {
    const engineer: EngineerIssueSet = {
      ...singleEngineer,
      issues: [
        makeIssue("i1", "in_progress", 50),
        makeIssue("i2", "in_progress", 52),
        makeIssue("i3", "in_progress", 49),
      ],
    };

    const scanResult = scanEngineerUtilization([engineer], DEFAULT_CONFIG, NOW);
    const anomalies = scanResult.engineers[0]!.anomalies;

    expect(anomalies.map((a) => a.type)).toContain("ENGINEER_ALL_STALLED_48H");
    // LEVEL-2 supersedes LEVEL-1 — no individual issue stall anomalies
    expect(anomalies.map((a) => a.type)).not.toContain("ENGINEER_ISSUE_STALLED_24H");

    const { api, calls } = makeMockApi();
    await executeActions(anomalies, makeCtx(api));

    expect(calls["sendFeishuDM"]!.length).toBe(1);
    expect(calls["sendFeishuDM"]![0]![0] as string).toMatch(/stalled/);
    expect(calls["createChildIssue"]!.length).toBe(1);
    const childParams = calls["createChildIssue"]![0]![0] as { assigneeAgentId: string; title: string };
    expect(childParams.assigneeAgentId).toBe("cto-agent-1");
    expect(childParams.title).toMatch(/URGENT/);
  });
});

// ────────────────────────────────────────────────
// Test 3: LEVEL-3 — in_review zombie > 72h → [REVIEW-ZOMBIE] comment
// ────────────────────────────────────────────────

describe("test_level3_review_zombie_72h", () => {
  it("detects REVIEW_ZOMBIE_72H and posts zombie comment", async () => {
    const engineer: EngineerIssueSet = {
      ...singleEngineer,
      issues: [makeIssue("zombie-issue", "in_review", 73)],
    };

    const scanResult = scanEngineerUtilization([engineer], DEFAULT_CONFIG, NOW);
    const anomalies = scanResult.engineers[0]!.anomalies;

    expect(anomalies.map((a) => a.type)).toContain("REVIEW_ZOMBIE_72H");

    const { api, calls } = makeMockApi();
    await executeActions(anomalies, makeCtx(api));

    expect(calls["postComment"]!.length).toBe(1);
    expect(calls["postComment"]![0]![0]).toBe("zombie-issue");
    expect(calls["postComment"]![0]![1] as string).toMatch(/\[REVIEW-ZOMBIE\]/);
  });
});

// ────────────────────────────────────────────────
// Test 4: Healthy engineer — no anomalies, no actions
// ────────────────────────────────────────────────

describe("test_no_anomaly_healthy_engineer", () => {
  it("returns empty anomalies and fires no API calls for recently-updated issues", async () => {
    const engineer: EngineerIssueSet = {
      ...singleEngineer,
      issues: [
        makeIssue("h1", "in_progress", 2),
        makeIssue("h2", "in_progress", 1),
      ],
    };

    const scanResult = scanEngineerUtilization([engineer], DEFAULT_CONFIG, NOW);
    const anomalies = scanResult.engineers[0]!.anomalies;

    expect(anomalies).toHaveLength(0);

    const { api, calls } = makeMockApi();
    await executeActions(anomalies, makeCtx(api));

    expect(calls["postComment"]!.length).toBe(0);
    expect(calls["sendFeishuDM"]!.length).toBe(0);
    expect(calls["createChildIssue"]!.length).toBe(0);
  });
});

// ────────────────────────────────────────────────
// Test 5: Idempotency — same anomaly twice → only one action
// ────────────────────────────────────────────────

describe("test_idempotency_no_duplicate_action", () => {
  it("fires action once and skips on second run within 24h", async () => {
    const engineer: EngineerIssueSet = {
      ...singleEngineer,
      issues: [makeIssue("issue-dup", "in_progress", 25)],
    };

    const scanResult = scanEngineerUtilization([engineer], DEFAULT_CONFIG, NOW);
    const anomalies = scanResult.engineers[0]!.anomalies;
    expect(anomalies.length).toBeGreaterThan(0);

    const { api, calls } = makeMockApi();
    const dedup = createInMemoryDedupStore();
    const ctx = makeCtx(api, { dedup });

    // First run — action fires
    const firstRun = await executeActions(anomalies, ctx);
    expect(firstRun.some((r) => !r.skipped)).toBe(true);
    const firstCommentCount = calls["postComment"]!.length;
    expect(firstCommentCount).toBeGreaterThan(0);

    // Second run (same dedup store, same 24h window) — all skipped
    const secondRun = await executeActions(anomalies, ctx);
    expect(secondRun.every((r) => r.skipped)).toBe(true);
    // No additional API calls
    expect(calls["postComment"]!.length).toBe(firstCommentCount);
  });
});
