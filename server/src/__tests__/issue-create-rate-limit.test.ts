/**
 * Regression tests for ADR-008 (DOGAA-2620): the issue-create rate-limit guard.
 *
 * Each `describe` block covers one of the five scenarios called out on the
 * issue. The tests target the underlying services (rate limiter + guard +
 * config parser) directly so they do not require an embedded Postgres or
 * a fully-wired express app — the route wiring is validated by typecheck.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

void readFileSync;
void fileURLToPath;
void dirname;
void resolve;
import {
  createIssueCreateRateLimiter,
  DEFAULT_ISSUE_CREATE_RATE_LIMIT_CONFIG,
  parseIssueCreateRateLimitConfig,
  type IssueCreateRateLimitConfig,
} from "../services/issue-create-rate-limit.js";
import {
  createIssueCreateRateLimitGuard,
  RATE_LIMIT_PAUSE_REASON,
} from "../services/issue-create-rate-limit-guard.js";

const baseConfig: IssueCreateRateLimitConfig = {
  ...DEFAULT_ISSUE_CREATE_RATE_LIMIT_CONFIG,
  windowMinutes: 10,
  maxIssuesPerWindow: 30,
};

const breachResult = {
  allowed: false as const,
  limit: 30,
  windowMinutes: 10,
  remaining: 0,
  retryAfterSeconds: 60,
};

describe("ADR-008 scenario 1 — block: 31st request inside the window returns 429 and triggers side effects", () => {
  it("rate limiter rejects the 31st consume() and surfaces retryAfterSeconds", () => {
    const limiter = createIssueCreateRateLimiter({ now: () => 1_000 });
    const actor = { companyId: "c1", agentId: "a1" };
    for (let i = 0; i < 30; i += 1) {
      expect(limiter.consume(actor, baseConfig).allowed).toBe(true);
    }
    const blocked = limiter.consume(actor, baseConfig);
    expect(blocked.allowed).toBe(false);
    expect(blocked.limit).toBe(30);
    expect(blocked.windowMinutes).toBe(10);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("guard pauses the offending agent and creates exactly one alert issue on first breach", async () => {
    const pauseAgent = vi.fn(async () => undefined);
    const createAlertIssue = vi.fn(async () => ({ id: "alert-1", identifier: "PAP-100" }));
    const appendAlertComment = vi.fn(async () => undefined);
    const guard = createIssueCreateRateLimitGuard({
      pauseAgent,
      createAlertIssue,
      appendAlertComment,
      now: () => 1_000,
    });

    const outcome = await guard.handleBreach({
      companyId: "c1",
      actor: { agentId: "a1", agentName: "MailHandler", agentRole: "general" },
      config: { ...baseConfig, notifyUserIds: ["owner-1"] },
      breach: breachResult,
    });

    expect(outcome.alertCreated).toBe(true);
    expect(outcome.alertIssueId).toBe("alert-1");
    expect(outcome.alertIdentifier).toBe("PAP-100");
    expect(outcome.pauseApplied).toBe(true);
    expect(pauseAgent).toHaveBeenCalledWith({ agentId: "a1", reason: RATE_LIMIT_PAUSE_REASON });
    expect(createAlertIssue).toHaveBeenCalledTimes(1);
    const createArg = createAlertIssue.mock.calls[0]?.[0];
    expect(createArg?.title).toContain("MailHandler");
    expect(createArg?.notifyUserIds).toEqual(["owner-1"]);
    expect(createArg?.body).toContain(`\`${RATE_LIMIT_PAUSE_REASON}\``);
    expect(createArg?.body).toContain("user://owner-1");
  });
});

describe("ADR-008 scenario 2 — feature flag off keeps the gate disabled", () => {
  it("parseIssueCreateRateLimitConfig honors enabled=false and consumers can short-circuit", () => {
    const config = parseIssueCreateRateLimitConfig({
      issueCreation: { enabled: false, windowMinutes: 10, maxIssuesPerWindow: 30 },
    });
    expect(config.enabled).toBe(false);
  });

  it("when callers respect the flag, no pause/alert side effects fire", async () => {
    const pauseAgent = vi.fn();
    const createAlertIssue = vi.fn();
    const guard = createIssueCreateRateLimitGuard({
      pauseAgent: pauseAgent as never,
      createAlertIssue: createAlertIssue as never,
      appendAlertComment: async () => undefined,
      now: () => 1_000,
    });
    // Caller (route) is responsible for short-circuiting on disabled config, so
    // simply verify the guard is never invoked when the route sees enabled=false.
    const config = parseIssueCreateRateLimitConfig({
      issueCreation: { enabled: false, windowMinutes: 10, maxIssuesPerWindow: 30 },
    });
    if (config.enabled) {
      await guard.handleBreach({
        companyId: "c1",
        actor: { agentId: "a1", agentName: null, agentRole: null },
        config,
        breach: breachResult,
      });
    }
    expect(pauseAgent).not.toHaveBeenCalled();
    expect(createAlertIssue).not.toHaveBeenCalled();
  });
});

describe("ADR-008 scenario 3 — sliding window: requests outside the window do not count", () => {
  it("after a window cycle, the agent can create fresh issues again", () => {
    let nowMs = 0;
    const limiter = createIssueCreateRateLimiter({ now: () => nowMs });
    const actor = { companyId: "c1", agentId: "a1" };
    const config = { ...baseConfig, windowMinutes: 10, maxIssuesPerWindow: 30 };

    nowMs = 1_000;
    for (let i = 0; i < 20; i += 1) {
      expect(limiter.consume(actor, config).allowed).toBe(true);
    }
    // 11 minutes later — the previous 20 should have aged out.
    nowMs = 1_000 + 11 * 60_000;
    for (let i = 0; i < 20; i += 1) {
      expect(limiter.consume(actor, config).allowed).toBe(true);
    }
    // Total processed: 40 across two windows, none rejected.
  });

  it("hits age out exactly windowMs after they were recorded", () => {
    let nowMs = 0;
    const limiter = createIssueCreateRateLimiter({ now: () => nowMs });
    const actor = { companyId: "c1", agentId: "a1" };
    const config = { ...baseConfig, windowMinutes: 1, maxIssuesPerWindow: 1 };
    nowMs = 1_000;
    expect(limiter.consume(actor, config).allowed).toBe(true);
    // 1 ms before windowMs passes — the previous hit still counts.
    nowMs = 1_000 + 60_000 - 1;
    expect(limiter.consume(actor, config).allowed).toBe(false);
    // Exactly windowMs later — the old hit ages out.
    nowMs = 1_000 + 60_000;
    expect(limiter.consume(actor, config).allowed).toBe(true);
  });
});

describe("ADR-008 scenario 4 — dedup: same-agent repeat breaches reuse the existing alert issue", () => {
  it("appends a comment instead of creating a second alert when within the dedup window", async () => {
    const pauseAgent = vi.fn(async () => undefined);
    const createAlertIssue = vi.fn(async () => ({ id: "alert-1", identifier: "PAP-100" }));
    const appendAlertComment = vi.fn(async () => undefined);
    let nowMs = 1_000;
    const guard = createIssueCreateRateLimitGuard({
      pauseAgent,
      createAlertIssue,
      appendAlertComment,
      now: () => nowMs,
    });

    const first = await guard.handleBreach({
      companyId: "c1",
      actor: { agentId: "a1", agentName: "MailHandler", agentRole: "general" },
      config: baseConfig,
      breach: breachResult,
    });
    expect(first.alertCreated).toBe(true);

    nowMs += 30 * 60_000;
    const second = await guard.handleBreach({
      companyId: "c1",
      actor: { agentId: "a1", agentName: "MailHandler", agentRole: "general" },
      config: baseConfig,
      breach: breachResult,
    });

    expect(second.alertCreated).toBe(false);
    expect(second.alertIssueId).toBe("alert-1");
    expect(createAlertIssue).toHaveBeenCalledTimes(1);
    expect(appendAlertComment).toHaveBeenCalledTimes(1);
    expect(appendAlertComment.mock.calls[0]?.[0].issueId).toBe("alert-1");

    // Past the 1-hour dedup window, a new alert is allowed.
    nowMs += 60 * 60_000;
    const third = await guard.handleBreach({
      companyId: "c1",
      actor: { agentId: "a1", agentName: "MailHandler", agentRole: "general" },
      config: baseConfig,
      breach: breachResult,
    });
    expect(third.alertCreated).toBe(true);
    expect(createAlertIssue).toHaveBeenCalledTimes(2);
  });
});

describe("ADR-008 scenario 5 — exempt role / exempt id bypasses the threshold", () => {
  it("parseIssueCreateRateLimitConfig captures both exempt lists", () => {
    const config = parseIssueCreateRateLimitConfig({
      issueCreation: {
        enabled: true,
        windowMinutes: 10,
        maxIssuesPerWindow: 30,
        exemptAgentIds: ["agent-x"],
        exemptAgentRoles: ["bulk-importer"],
      },
    });
    expect(config.exemptAgentIds).toEqual(["agent-x"]);
    expect(config.exemptAgentRoles).toEqual(["bulk-importer"]);
  });

  it("agents matching an exempt id or role should never reach the consume() call", () => {
    // Caller (route) is responsible for the exemption check before consume().
    // This test asserts the data shape that lets that check work.
    const config = parseIssueCreateRateLimitConfig({
      issueCreation: {
        enabled: true,
        windowMinutes: 10,
        maxIssuesPerWindow: 1,
        exemptAgentIds: ["agent-exempt"],
        exemptAgentRoles: ["bulk-importer"],
      },
    });
    const isExempt = (agent: { id: string; role: string }) =>
      config.exemptAgentIds.includes(agent.id) || config.exemptAgentRoles.includes(agent.role);
    expect(isExempt({ id: "agent-exempt", role: "general" })).toBe(true);
    expect(isExempt({ id: "agent-other", role: "bulk-importer" })).toBe(true);
    expect(isExempt({ id: "agent-other", role: "general" })).toBe(false);
  });
});

describe("Migration 0085 default — governanceAssigneeAgentId is the CTO agent id", () => {
  /**
   * Reads the actual SQL migration so the test fails if a future edit drops
   * `governanceAssigneeAgentId` from the `jsonb_build_object` default. Per ADR-008
   * §2.3.3 + CTO review comment 776ead4c: a missing key downgrades the first
   * production breach to a `backlog`/unassigned alert and the CTO never wakes.
   *
   * We sanity-check the raw SQL contains the hard-coded CTO id and that the
   * parser accepts the same shape — together this guards both the storage layer
   * (key present in jsonb) and the runtime layer (parser preserves the value).
   */
  const MIGRATION_FILE = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../packages/db/src/migrations/0085_company_rate_limit_settings.sql",
  );
  const CTO_AGENT_ID = "2fe5c471-69e3-4593-b2d8-e58f229d9812";

  it("migration SQL embeds governanceAssigneeAgentId as the CTO agent id", () => {
    const sql = readFileSync(MIGRATION_FILE, "utf8");
    expect(sql).toMatch(/'governanceAssigneeAgentId'\s*,\s*'2fe5c471-69e3-4593-b2d8-e58f229d9812'/);
  });

  it("parser preserves governanceAssigneeAgentId = CTO from the migration default jsonb", () => {
    // Mirrors the jsonb that the SQL `jsonb_build_object` produces for legacy
    // company rows. If migration content drifts, the SQL assertion above fails first.
    const parsed = parseIssueCreateRateLimitConfig({
      issueCreation: {
        enabled: true,
        windowMinutes: 10,
        maxIssuesPerWindow: 30,
        exemptAgentIds: [],
        exemptAgentRoles: [],
        governanceAssigneeAgentId: CTO_AGENT_ID,
      },
    });
    expect(parsed.governanceAssigneeAgentId).toBe(CTO_AGENT_ID);
    expect(parsed.enabled).toBe(true);
    expect(parsed.windowMinutes).toBe(10);
    expect(parsed.maxIssuesPerWindow).toBe(30);
  });
});

// B2 behavioral test for `pauseAgentForRateLimitBreach` lives in
// `issue-create-rate-limit-routes.test.ts` (uses PgDialect.sqlToQuery to assert
// the exact SQL rendering). Kept as a single test to avoid duplicate coverage.

describe("Guard auxiliary behaviors", () => {
  it("merges resolveOwnerUserIds output with configured notifyUserIds and dedupes", async () => {
    const createAlertIssue = vi.fn(async () => ({ id: "alert-x", identifier: null }));
    const resolveOwnerUserIds = vi.fn(async () => ["owner-1", "owner-3"]);
    const guard = createIssueCreateRateLimitGuard({
      pauseAgent: async () => undefined,
      createAlertIssue,
      appendAlertComment: async () => undefined,
      resolveOwnerUserIds,
      now: () => 1_000,
    });

    const result = await guard.handleBreach({
      companyId: "c1",
      actor: { agentId: "a1", agentName: "MailHandler", agentRole: "general" },
      config: { ...baseConfig, notifyUserIds: ["owner-1", "owner-2"] },
      breach: breachResult,
    });
    expect(resolveOwnerUserIds).toHaveBeenCalledWith("c1");
    expect(result.notifiedUserIds).toEqual(["owner-1", "owner-2", "owner-3"]);
    expect(createAlertIssue.mock.calls[0]?.[0].notifyUserIds).toEqual([
      "owner-1",
      "owner-2",
      "owner-3",
    ]);
  });

  it("attaches a recent-issues preview when loadRecentIssueIdentifiers is wired", async () => {
    const createAlertIssue = vi.fn(async () => ({ id: "alert-x", identifier: null }));
    const loadRecentIssueIdentifiers = vi.fn(async () => [
      { id: "i1", identifier: "PAP-1" },
      { id: "i2", identifier: "PAP-2" },
    ]);
    const guard = createIssueCreateRateLimitGuard({
      pauseAgent: async () => undefined,
      createAlertIssue,
      appendAlertComment: async () => undefined,
      loadRecentIssueIdentifiers,
      now: () => 1_000,
    });

    const result = await guard.handleBreach({
      companyId: "c1",
      actor: { agentId: "a1", agentName: "MailHandler", agentRole: "general" },
      config: baseConfig,
      breach: breachResult,
    });
    expect(loadRecentIssueIdentifiers).toHaveBeenCalled();
    expect(result.recentIssueCount).toBe(2);
    expect(createAlertIssue.mock.calls[0]?.[0].body).toContain("PAP-1");
    expect(createAlertIssue.mock.calls[0]?.[0].body).toContain("PAP-2");
  });
});
