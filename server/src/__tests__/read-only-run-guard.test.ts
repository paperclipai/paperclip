import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  evaluateReadOnlyRunMutation,
  readOnlyRunGuard,
} from "../services/read-only-run-guard.ts";

const COMPANY = "22222222-2222-4222-8222-222222222222";
const RUN = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN = "12111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const OTHER_AGENT = "34333333-3333-4333-8333-333333333333";
const READ_ONLY_ISSUE = "55555555-5555-4555-8555-555555555555";
const STANDARD_ISSUE = "66666666-6666-4666-8666-666666666666";

type Scripted = {
  run?: Record<string, unknown> | null;
  issue?: Record<string, unknown> | null;
  error?: Error;
};

/** Minimal drizzle-shaped stub: selections are told apart by their columns. */
function stubDb(script: Scripted) {
  const queries: string[] = [];
  const db = {
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          then: (resolve: (rows: unknown[]) => unknown) => {
            if (script.error) return Promise.reject(script.error);
            if ("workMode" in selection) {
              queries.push("issue");
              return resolve(script.issue === undefined ? [] : script.issue ? [script.issue] : []);
            }
            queries.push("run");
            return resolve(script.run === undefined ? [] : script.run ? [script.run] : []);
          },
        }),
      }),
    }),
  };
  return { db: db as never, queries };
}

function runRow(issueId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: RUN,
    agentId: AGENT,
    status: "running",
    contextSnapshot: { issueId, wakeReason: "next_from_backlog" },
    ...overrides,
  };
}

function guardApp(
  db: never,
  actor: Record<string, unknown>,
  calls: { mutations: number },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use(readOnlyRunGuard(db));
  app.post("/api/issues/:id/comments", (_req, res) => {
    calls.mutations += 1;
    res.status(201).json({ ok: true });
  });
  app.get("/api/issues/:id", (_req, res) => res.json({ ok: true }));
  return app;
}

const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: AGENT,
  companyId: COMPANY,
  runId: RUN,
};

describe("evaluateReadOnlyRunMutation", () => {
  it("denies a verified active run dispatched for an issue in read_only work mode", async () => {
    const { db } = stubDb({
      run: runRow(READ_ONLY_ISSUE),
      issue: { id: READ_ONLY_ISSUE, identifier: "TASK-1", workMode: "read_only" },
    });
    await expect(evaluateReadOnlyRunMutation(db, { companyId: COMPANY, agentId: AGENT, runId: RUN }))
      .resolves.toEqual({
        denied: true,
        reason: "read_only",
        issueId: READ_ONLY_ISSUE,
        issueIdentifier: "TASK-1",
      });
  });

  it("allows a verified active run whose issue is in another work mode", async () => {
    const { db } = stubDb({
      run: runRow(STANDARD_ISSUE),
      issue: { id: STANDARD_ISSUE, identifier: "TASK-2", workMode: "standard" },
    });
    await expect(evaluateReadOnlyRunMutation(db, { companyId: COMPANY, agentId: AGENT, runId: RUN }))
      .resolves.toEqual({ denied: false, reason: "not_read_only" });
  });

  it.each([
    ["missing run id", undefined, runRow(READ_ONLY_ISSUE)],
    ["malformed run id", "not-a-uuid", runRow(READ_ONLY_ISSUE)],
    ["unknown run", RUN, null],
    ["foreign run", OTHER_RUN, runRow(READ_ONLY_ISSUE, { id: OTHER_RUN, agentId: OTHER_AGENT })],
    ["completed run", RUN, runRow(READ_ONLY_ISSUE, { status: "succeeded" })],
  ])("fails closed for %s", async (_name, runId, run) => {
    const { db } = stubDb({ run });
    await expect(evaluateReadOnlyRunMutation(db, { companyId: COMPANY, agentId: AGENT, runId }))
      .resolves.toEqual({
        denied: true,
        reason: "run_identity_required",
        issueId: null,
        issueIdentifier: null,
      });
  });
});

describe("readOnlyRunGuard", () => {
  it("refuses a mutation from a read-only run and never runs the route", async () => {
    const { db } = stubDb({
      run: runRow(READ_ONLY_ISSUE),
      issue: { id: READ_ONLY_ISSUE, identifier: "TASK-1", workMode: "read_only" },
    });
    const calls = { mutations: 0 };
    const app = guardApp(db, agentActor, calls);

    const response = await request(app)
      .post(`/api/issues/${READ_ONLY_ISSUE}/comments`)
      .send({ body: "trying to write" });

    expect(response.status).toBe(403);
    expect(response.body.details.code).toBe("issue_write_read_only_run");
    expect(response.body.details.runId).toBe(RUN);
    expect(response.body.error).toContain("Who can act:");
    expect(calls.mutations).toBe(0);
  });

  it("cannot bypass the guard by omitting the run id", async () => {
    const { db, queries } = stubDb({});
    const calls = { mutations: 0 };
    const app = guardApp(db, { ...agentActor, runId: undefined }, calls);

    const response = await request(app)
      .post(`/api/issues/${READ_ONLY_ISSUE}/comments`)
      .send({ body: "attempted bypass" });

    expect(response.status).toBe(403);
    expect(response.body.details.code).toBe("issue_write_run_identity_required");
    expect(calls.mutations).toBe(0);
    expect(queries).toEqual([]);
  });

  it("fails closed when the identity lookup errors and never runs the route", async () => {
    const { db } = stubDb({ error: new Error("temporary database failure") });
    const calls = { mutations: 0 };
    const app = guardApp(db, agentActor, calls);

    const response = await request(app)
      .post(`/api/issues/${READ_ONLY_ISSUE}/comments`)
      .send({ body: "attempted write" });

    expect(response.status).toBe(403);
    expect(response.body.details.code).toBe("issue_write_run_identity_required");
    expect(calls.mutations).toBe(0);
  });

  it("lets reads through without a database lookup", async () => {
    const { db, queries } = stubDb({});
    const calls = { mutations: 0 };
    const app = guardApp(db, agentActor, calls);

    const response = await request(app).get(`/api/issues/${READ_ONLY_ISSUE}`);

    expect(response.status).toBe(200);
    expect(queries).toEqual([]);
  });

  it("lets a verified standard run mutate", async () => {
    const { db } = stubDb({
      run: runRow(STANDARD_ISSUE),
      issue: { id: STANDARD_ISSUE, identifier: "TASK-2", workMode: "standard" },
    });
    const calls = { mutations: 0 };
    const app = guardApp(db, agentActor, calls);

    const response = await request(app)
      .post(`/api/issues/${STANDARD_ISSUE}/comments`)
      .send({ body: "normal write" });

    expect(response.status).toBe(201);
    expect(calls.mutations).toBe(1);
  });

  it("does not touch board sessions", async () => {
    const { db, queries } = stubDb({});
    const calls = { mutations: 0 };
    const app = guardApp(db, { type: "board", source: "session", userId: "user-1" }, calls);

    const response = await request(app)
      .post(`/api/issues/${STANDARD_ISSUE}/comments`)
      .send({ body: "human write" });

    expect(response.status).toBe(201);
    expect(queries).toEqual([]);
  });
});
