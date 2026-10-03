import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { statusDigestRoutes } from "../routes/status-digest.ts";
import { statusDigestService } from "../services/status-digest.ts";

const mockAccess = vi.hoisted(() => ({ decide: vi.fn() }));
vi.mock("../services/access.js", () => ({ accessService: () => mockAccess }));
beforeEach(() => {
  mockAccess.decide.mockReset();
  mockAccess.decide.mockResolvedValue({ allowed: true });
});

const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY = "99999999-9999-4999-8999-999999999999";

/**
 * Responses are consumed in call order: the service issues its five selects
 * inside one `Promise.all` (issues, window runs, live runs, approvals,
 * interactions) and then the single aggregate query.
 */
function queueDb(responses: unknown[]) {
  const seen: number[] = [];
  let index = 0;
  const next = () => {
    seen.push(index);
    return responses[index++];
  };
  const db = {
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        groupBy: () => next(),
        then: (resolve: (rows: unknown) => unknown) => Promise.resolve(next()).then(resolve),
      };
      return chain;
    },
    execute: async () => next(),
  };
  return { db: db as never, seen };
}

function digestFixture() {
  return [
    [
      { status: "todo", count: "4" },
      { status: "in_progress", count: 3 },
      { status: "in_review", count: 2 },
      { status: "blocked", count: 5 },
      { status: "done", count: 100 },
      { status: "cancelled", count: 7 },
    ],
    [
      { status: "succeeded", count: "10" },
      { status: "failed", count: 1 },
      { status: "timed_out", count: "2" },
    ],
    [
      { status: "running", count: 2 },
      { status: "queued", count: "1" },
    ],
    [{ count: "3" }],
    [{ count: 4 }],
    [{ median_duration_seconds: 442.94, output_tokens: "21769" }],
  ];
}

function digestApp(db: never, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", statusDigestRoutes(db));
  app.use(errorHandler);
  return app;
}

describe("statusDigestService", () => {
  it("compresses the board into counts and one 24 h run window", async () => {
    const { db } = queueDb(digestFixture());
    const digest = await statusDigestService(db).digest(COMPANY);

    expect(digest.companyId).toBe(COMPANY);
    expect(digest.windowHours).toBe(24);
    expect(digest.issues.byStatus).toEqual({
      todo: 4,
      in_progress: 3,
      in_review: 2,
      blocked: 5,
      done: 100,
      cancelled: 7,
    });
    // Open = everything that is neither done nor cancelled.
    expect(digest.issues.open).toBe(14);
    expect(digest.issues.blocked).toBe(5);
    expect(digest.issues.inReview).toBe(2);
    expect(digest.issues.inProgress).toBe(3);
    expect(digest.runs.running).toBe(2);
    expect(digest.runs.queued).toBe(1);
    expect(digest.runs.window).toEqual({
      total: 13,
      succeeded: 10,
      failed: 1,
      timedOut: 2,
      medianDurationSeconds: 442.9,
      outputTokens: 21769,
    });
    expect(digest.approvals.pending).toBe(3);
    expect(digest.humanWaits.pendingInteractions).toBe(4);
  });

  it("survives an empty board without inventing numbers", async () => {
    const { db } = queueDb([[], [], [], [{ count: 0 }], [{ count: 0 }], []]);
    const digest = await statusDigestService(db).digest(COMPANY);

    expect(digest.issues.byStatus).toEqual({});
    expect(digest.issues.open).toBe(0);
    expect(digest.runs.window.medianDurationSeconds).toBeNull();
    expect(digest.runs.window.outputTokens).toBe(0);
    expect(digest.runs.running).toBe(0);
  });
});

describe("GET /api/companies/:companyId/status-digest", () => {
  it("refuses company aggregates outside the actor's read boundary before querying", async () => {
    mockAccess.decide.mockResolvedValue({ allowed: false, reason: "deny_trust_boundary" });
    const { db, seen } = queueDb(digestFixture());
    const actor = {
      type: "agent",
      source: "agent_jwt",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: COMPANY,
      runId: "44444444-4444-4444-8444-444444444444",
    };
    const response = await request(digestApp(db, actor))
      .get(`/api/companies/${COMPANY}/status-digest`);

    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
    expect(response.body.humanWaits).toBeUndefined();
    expect(mockAccess.decide).toHaveBeenCalledWith({
      actor,
      action: "company_scope:read",
      resource: { type: "company", companyId: COMPANY },
    });
  });

  it("answers an agent key in the same company", async () => {
    const { db } = queueDb(digestFixture());
    const response = await request(digestApp(db, {
      type: "agent",
      source: "agent_key",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: COMPANY,
    })).get(`/api/companies/${COMPANY}/status-digest`);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.issues.open).toBe(14);
  });

  it("refuses an agent key scoped to another company", async () => {
    const { db } = queueDb(digestFixture());
    const response = await request(digestApp(db, {
      type: "agent",
      source: "agent_key",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: OTHER_COMPANY,
    })).get(`/api/companies/${COMPANY}/status-digest`);

    expect(response.status).toBe(403);
  });
});
