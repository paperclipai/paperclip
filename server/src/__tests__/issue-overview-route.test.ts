import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueOverviewRoutes, parseIssueOverviewIds } from "../routes/issue-overviews.js";
import {
  ISSUE_OVERVIEW_MAX_IDS,
  deriveIssueOverviewPhase,
  isMergeSuperseded,
  type IssuePhaseEvidence,
} from "../services/issue-overviews.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "33333333-3333-4333-8333-333333333333";

const NO_EVIDENCE: IssuePhaseEvidence = {
  historyStatus: null,
  deliveryPhase: null,
  deliveryAt: null,
  deliveryMerged: false,
  mergedAt: null,
  lastLiveTransitionAt: null,
  executionStage: null,
};

/**
 * The projection reads Paperclip's own rows for every company-scoped query, so
 * a company that owns none of the requested ids sees empties rather than rows.
 * This stub lets the negative cases assert the response without a database.
 */
function emptyResultDb() {
  const select = () => {
    const chain: unknown = new Proxy({}, {
      get: (_target, property) => {
        if (property === "then") {
          return (onFulfilled: (value: unknown[]) => unknown) => Promise.resolve([]).then(onFulfilled);
        }
        if (property === "catch" || property === "finally") {
          return (handler: (value: unknown[]) => unknown) => Promise.resolve([])[property](handler);
        }
        return () => chain;
      },
    });
    return chain;
  };
  const selectCalls = { count: 0 };
  return {
    selectCalls,
    db: {
      select: (...args: unknown[]) => {
        selectCalls.count += 1;
        return select(...args);
      },
    } as unknown as Db,
  };
}

function buildApp(actor: Express.Request["actor"], db: Db = emptyResultDb().db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor?: Express.Request["actor"] }).actor = actor;
    next();
  });
  app.use("/api", issueOverviewRoutes(db));
  app.use(errorHandler);
  return app;
}

function boardActor(companyIds: string[]): Express.Request["actor"] {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    companyIds,
    memberships: companyIds.map((companyId) => ({
      companyId,
      membershipRole: "owner",
      status: "active",
    })),
  } as Express.Request["actor"];
}

describe("deriveIssueOverviewPhase", () => {
  it("reads the phase of a non-blocked status directly", () => {
    expect(deriveIssueOverviewPhase("in_review", NO_EVIDENCE)).toEqual({
      phase: "in_review",
      source: "status",
    });
    expect(deriveIssueOverviewPhase("todo", NO_EVIDENCE)).toEqual({ phase: "todo", source: "status" });
  });

  it("derives the phase of a delivery-blocked task from its delivery evidence", () => {
    // The unit is blocked without the issue status changing, so the status alone
    // would claim a phase the record does not support.
    expect(deriveIssueOverviewPhase("in_progress", {
      ...NO_EVIDENCE,
      blocked: true,
      deliveryPhase: "in_review",
      deliveryAt: new Date("2026-02-01T10:00:00Z"),
    })).toEqual({ phase: "in_review", source: "delivery" });
  });

  it("keeps a blocked review in review from retained delivery evidence", () => {
    expect(deriveIssueOverviewPhase("blocked", {
      ...NO_EVIDENCE,
      deliveryPhase: "in_review",
      deliveryAt: new Date("2026-02-01T10:00:00Z"),
    })).toEqual({ phase: "in_review", source: "delivery" });
  });

  it("keeps a task blocked out of in_progress in progress", () => {
    expect(deriveIssueOverviewPhase("blocked", {
      ...NO_EVIDENCE,
      historyStatus: "in_progress",
    })).toEqual({ phase: "in_progress", source: "history" });
  });

  it("reports null instead of guessing when a blocked task has no recorded phase", () => {
    // An issue created directly into `blocked`. The board must show "stage not
    // recorded", not a fabricated lane.
    expect(deriveIssueOverviewPhase("blocked", NO_EVIDENCE)).toEqual({
      phase: null,
      source: "unknown",
    });
  });

  it("uses an explicit pending execution stage when nothing else was recorded", () => {
    expect(deriveIssueOverviewPhase("blocked", {
      ...NO_EVIDENCE,
      executionStage: "review",
    })).toEqual({ phase: "in_review", source: "execution" });
  });

  it("does not treat a missing delivery record as a recorded phase", () => {
    // `not_started` is the absence of a phase, so it must not win over history.
    expect(deriveIssueOverviewPhase("blocked", {
      ...NO_EVIDENCE,
      deliveryPhase: "not_started",
      deliveryAt: new Date("2026-02-03T10:00:00Z"),
      historyStatus: "in_review",
    })).toEqual({ phase: "in_review", source: "history" });
  });

  it("prefers a newer live phase over a stale non-merged delivery phase", () => {
    // The unit still says in_review, but the task moved into a new
    // implementation cycle after the unit was last observed.
    expect(deriveIssueOverviewPhase("blocked", {
      ...NO_EVIDENCE,
      deliveryPhase: "in_review",
      deliveryAt: new Date("2026-02-01T10:00:00Z"),
      historyStatus: "in_progress",
      lastLiveTransitionAt: new Date("2026-02-05T10:00:00Z"),
    })).toEqual({ phase: "in_progress", source: "history" });
    // With no newer live phase, the delivery record still wins.
    expect(deriveIssueOverviewPhase("blocked", {
      ...NO_EVIDENCE,
      deliveryPhase: "in_review",
      deliveryAt: new Date("2026-02-05T10:00:00Z"),
      historyStatus: "in_progress",
      lastLiveTransitionAt: new Date("2026-02-01T10:00:00Z"),
    })).toEqual({ phase: "in_review", source: "delivery" });
  });

  it("keeps a task blocked out of the phase of a superseded merged delivery", () => {
    expect(deriveIssueOverviewPhase("blocked", {
      ...NO_EVIDENCE,
      deliveryPhase: "done",
      deliveryAt: new Date("2026-01-01T10:00:00Z"),
      deliveryMerged: true,
      mergedAt: new Date("2026-01-01T10:00:00Z"),
      lastLiveTransitionAt: new Date("2026-02-01T10:00:00Z"),
      historyStatus: "in_progress",
    })).toEqual({ phase: "in_progress", source: "history" });
  });

  it("keeps a merge current while its own cycle is the current one", () => {
    const mergedAt = new Date("2026-03-01T10:00:00Z");
    // The last live transition is the `merging` phase the merge completed.
    expect(deriveIssueOverviewPhase("blocked", {
      ...NO_EVIDENCE,
      deliveryPhase: "done",
      deliveryAt: mergedAt,
      deliveryMerged: true,
      mergedAt,
      lastLiveTransitionAt: new Date("2026-02-28T10:00:00Z"),
      historyStatus: "done",
    })).toEqual({ phase: "done", source: "delivery" });
    // A merge with no recorded live transition behind it is the newest evidence.
    expect(deriveIssueOverviewPhase("blocked", {
      ...NO_EVIDENCE,
      deliveryPhase: "done",
      deliveryAt: mergedAt,
      deliveryMerged: true,
      mergedAt,
      historyStatus: "in_progress",
    })).toEqual({ phase: "done", source: "delivery" });
  });

  it("trusts a non-merged delivery unit over an older status transition", () => {
    expect(deriveIssueOverviewPhase("blocked", {
      ...NO_EVIDENCE,
      deliveryPhase: "ready_to_merge",
      deliveryAt: new Date("2026-03-01T10:00:00Z"),
      historyStatus: "in_review",
      lastLiveTransitionAt: new Date("2026-02-01T10:00:00Z"),
    })).toEqual({ phase: "ready_to_merge", source: "delivery" });
  });
});

describe("isMergeSuperseded", () => {
  const mergedAt = new Date("2026-01-01T10:00:00Z");

  it("is not superseded without a merge or without a live transition", () => {
    expect(isMergeSuperseded({ mergedAt: null, lastLiveTransitionAt: new Date("2026-02-01T10:00:00Z") })).toBe(false);
    expect(isMergeSuperseded({ mergedAt, lastLiveTransitionAt: null })).toBe(false);
  });

  it("is not superseded when the last live transition preceded the merge", () => {
    expect(isMergeSuperseded({
      mergedAt,
      lastLiveTransitionAt: new Date("2025-12-31T10:00:00Z"),
    })).toBe(false);
  });

  it("is superseded by a reopen that precedes a later done", () => {
    // A final `done` transition is not the newest live one, so it cannot hide
    // the reopen that happened between the old merge and it.
    expect(isMergeSuperseded({
      mergedAt,
      lastLiveTransitionAt: new Date("2026-02-01T10:00:00Z"),
    })).toBe(true);
  });
});

describe("parseIssueOverviewIds", () => {
  it("treats absent or blank input as an empty request", () => {
    expect(parseIssueOverviewIds(undefined)).toEqual([]);
    expect(parseIssueOverviewIds("")).toEqual([]);
    expect(parseIssueOverviewIds("  ,  ")).toEqual([]);
  });

  it("trims, lowercases and deduplicates ids", () => {
    expect(parseIssueOverviewIds(` ${ISSUE_ID.toUpperCase()} , ${ISSUE_ID} `)).toEqual([ISSUE_ID]);
  });

  it("accepts exactly the maximum and rejects one more unique id", () => {
    const unique = (count: number) =>
      Array.from({ length: count }, (_value, index) =>
        `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`).join(",");
    expect(parseIssueOverviewIds(unique(ISSUE_OVERVIEW_MAX_IDS))).toHaveLength(ISSUE_OVERVIEW_MAX_IDS);
    expect(() => parseIssueOverviewIds(unique(ISSUE_OVERVIEW_MAX_IDS + 1))).toThrow(
      /at most 100 unique ids/,
    );
  });

  it("honours the cap after deduplication, not before", () => {
    const repeated = Array.from({ length: ISSUE_OVERVIEW_MAX_IDS * 3 }, () => ISSUE_ID).join(",");
    expect(parseIssueOverviewIds(repeated)).toEqual([ISSUE_ID]);
  });

  it("rejects non-uuid ids rather than silently dropping them", () => {
    expect(() => parseIssueOverviewIds("PAP-1383")).toThrow(/comma-separated list of issue UUIDs/);
    expect(() => parseIssueOverviewIds(`${ISSUE_ID},not-an-id`)).toThrow(
      /comma-separated list of issue UUIDs/,
    );
  });
});

describe("issue overview route", () => {
  it("denies an agent key", async () => {
    const app = buildApp({
      type: "agent",
      agentId: "agent-1",
      companyId: COMPANY_ID,
    } as Express.Request["actor"]);
    await request(app)
      .get(`/api/companies/${COMPANY_ID}/issue-overviews?issueIds=${ISSUE_ID}`)
      .expect(403);
  });

  it("denies an unauthenticated caller", async () => {
    const app = buildApp({ type: "none" } as Express.Request["actor"]);
    await request(app)
      .get(`/api/companies/${COMPANY_ID}/issue-overviews?issueIds=${ISSUE_ID}`)
      .expect(401);
  });

  it("denies a board user without the company", async () => {
    const app = buildApp(boardActor([OTHER_COMPANY_ID]));
    await request(app)
      .get(`/api/companies/${COMPANY_ID}/issue-overviews?issueIds=${ISSUE_ID}`)
      .expect(403);
  });

  it("rejects malformed and oversized input before reading anything", async () => {
    const { db, selectCalls } = emptyResultDb();
    const app = buildApp(boardActor([COMPANY_ID]), db);
    await request(app)
      .get(`/api/companies/${COMPANY_ID}/issue-overviews?issueIds=nope`)
      .expect(400);
    const oversized = Array.from({ length: ISSUE_OVERVIEW_MAX_IDS + 1 }, (_value, index) =>
      `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`).join(",");
    await request(app)
      .get(`/api/companies/${COMPANY_ID}/issue-overviews?issueIds=${oversized}`)
      .expect(400);
    expect(selectCalls.count).toBe(0);
  });

  it("returns an empty projection for an empty request without touching the database", async () => {
    const { db, selectCalls } = emptyResultDb();
    const app = buildApp(boardActor([COMPANY_ID]), db);
    const response = await request(app)
      .get(`/api/companies/${COMPANY_ID}/issue-overviews`)
      .expect(200);
    expect(response.body.items).toEqual([]);
    expect(Number.isNaN(Date.parse(response.body.observedAt))).toBe(false);
    expect(selectCalls.count).toBe(0);
  });

  it("returns empties for ids the company does not own, revealing no other company's rows", async () => {
    const app = buildApp(boardActor([COMPANY_ID]));
    const response = await request(app)
      .get(`/api/companies/${COMPANY_ID}/issue-overviews?issueIds=${ISSUE_ID}`)
      .expect(200);
    expect(response.body.items).toEqual([]);
    expect(Number.isNaN(Date.parse(response.body.observedAt))).toBe(false);
  });
});
