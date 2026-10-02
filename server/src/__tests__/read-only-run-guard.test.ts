import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  evaluateReadOnlyRunMutation,
  readOnlyRunGuard,
} from "../services/read-only-run-guard.ts";

const COMPANY = "22222222-2222-4222-8222-222222222222";
const RUN = "11111111-1111-4111-8111-111111111111";
const READ_ONLY_ISSUE = "55555555-5555-4555-8555-555555555555";
const STANDARD_ISSUE = "66666666-6666-4666-8666-666666666666";

type Scripted = {
  run?: Record<string, unknown> | null;
  issue?: Record<string, unknown> | null;
};

/** Minimal drizzle-shaped stub: selections are told apart by their columns. */
function stubDb(script: Scripted) {
  const queries: string[] = [];
  const db = {
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          then: (resolve: (rows: unknown[]) => unknown) => {
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

function runRow(issueId: string) {
  return {
    id: RUN,
    companyId: COMPANY,
    contextSnapshot: { issueId, wakeReason: "next_from_backlog" },
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
  agentId: "33333333-3333-4333-8333-333333333333",
  companyId: COMPANY,
  runId: RUN,
};

describe("evaluateReadOnlyRunMutation", () => {
  it("denies a run dispatched for an issue in read_only work mode", async () => {
    const { db } = stubDb({
      run: runRow(READ_ONLY_ISSUE),
      issue: { id: READ_ONLY_ISSUE, identifier: "TASK-1", workMode: "read_only" },
    });
    await expect(evaluateReadOnlyRunMutation(db, { companyId: COMPANY, runId: RUN }))
      .resolves.toEqual({
        denied: true,
        issueId: READ_ONLY_ISSUE,
        issueIdentifier: "TASK-1",
      });
  });

  it("allows a run whose issue is in any other work mode", async () => {
    const { db } = stubDb({
      run: runRow(STANDARD_ISSUE),
      issue: { id: STANDARD_ISSUE, identifier: "TASK-2", workMode: "standard" },
    });
    await expect(evaluateReadOnlyRunMutation(db, { companyId: COMPANY, runId: RUN }))
      .resolves.toEqual({ denied: false, reason: "not_read_only" });
  });

  it("treats an unknown run as not read-only without failing the request", async () => {
    const { db } = stubDb({ run: null });
    await expect(evaluateReadOnlyRunMutation(db, { companyId: COMPANY, runId: RUN }))
      .resolves.toEqual({ denied: false, reason: "unknown_run" });
  });

  it("rejects a malformed run header before it reaches the database", async () => {
    const { db, queries } = stubDb({});
    await expect(
      evaluateReadOnlyRunMutation(db, { companyId: COMPANY, runId: "not-a-uuid" }),
    ).resolves.toEqual({ denied: false, reason: "unsafe_identifier" });
    expect(queries).toEqual([]);
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
    // The write never reached the route, so nothing was persisted by it.
    expect(calls.mutations).toBe(0);
  });

  it("lets reads through without a database lookup", async () => {
    const { db, queries } = stubDb({
      run: runRow(READ_ONLY_ISSUE),
      issue: { id: READ_ONLY_ISSUE, identifier: "TASK-1", workMode: "read_only" },
    });
    const calls = { mutations: 0 };
    const app = guardApp(db, agentActor, calls);

    const response = await request(app).get(`/api/issues/${READ_ONLY_ISSUE}`);

    expect(response.status).toBe(200);
    expect(queries).toEqual([]);
  });

  it("leaves runs on standard work modes untouched", async () => {
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

  it("does not touch requests without a run id", async () => {
    const { db, queries } = stubDb({});
    const calls = { mutations: 0 };
    const app = guardApp(db, { ...agentActor, runId: undefined }, calls);

    const response = await request(app)
      .post(`/api/issues/${STANDARD_ISSUE}/comments`)
      .send({ body: "no run header" });

    expect(response.status).toBe(201);
    expect(queries).toEqual([]);
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
