import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { ISSUE_SUMMARIES_MAX_IDS } from "@paperclipai/shared";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { authorizationService, READ_DECISION_CONCURRENCY, type AuthorizationActor } from "../services/authorization.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";
import {
  ISSUE_READ_VISIBILITY_ACTORS, seedIssueReadVisibilityFixture, type IssueReadVisibilityActorName,
  type IssueReadVisibilityFixture,
} from "./helpers/issue-read-visibility-fixture.js";

/** Actors that the company gate rejects before any task is read. The routes answer every other actor with 200. */
const REJECTED_BY_COMPANY_GATE: Partial<Record<IssueReadVisibilityActorName, 401 | 403>> = {
  "board without membership": 403,
  "agent run for owner, membership read from the database": 403,
  "agent run for a user without membership": 403,
  "agent of another company": 403,
  "unauthenticated": 401,
};

/** The statement one task-privacy check per task sends. */
const PER_TASK_PRIVACY_STATEMENT = /^select "id" from "issues" where \("issues"\."id" = \$1 and "issues"\."company_id" = \$2 and exists/;

describeEmbeddedPostgres("batched task read filtering", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-read-batch-");
  const oldPrivacy = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  let f: IssueReadVisibilityFixture;
  beforeAll(async () => {
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    f = await seedIssueReadVisibilityFixture(ctx.db, { publicCount: 60 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(() => {
    if (oldPrivacy === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = oldPrivacy;
  });

  type Row = Pick<typeof issues.$inferSelect, "id" | "companyId" | "projectId" | "parentId" | "assigneeAgentId" | "assigneeUserId" | "status">;
  async function rowsFor(ids: string[]): Promise<Row[]> {
    const rows = await ctx.db.select({
      id: issues.id, companyId: issues.companyId, projectId: issues.projectId, parentId: issues.parentId,
      assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId, status: issues.status,
    }).from(issues).where(inArray(issues.id, ids));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }
  const resource = (row: Row, companyId = row.companyId) => ({
    type: "issue" as const, companyId, issueId: row.id, projectId: row.projectId, parentIssueId: row.parentId,
    assigneeAgentId: row.assigneeAgentId, assigneeUserId: row.assigneeUserId, status: row.status,
  });
  /** The reference: one authorization decision per task, as the routes asked before batching. */
  function decideEachTask(actor: AuthorizationActor, rows: Row[], companyId?: string) {
    return Promise.all(rows.map((row) => authorizationService(ctx.db).decide({
      actor: { ...actor }, action: "issue:read", resource: resource(row, companyId),
      scope: { issueId: row.id, projectId: row.projectId, parentIssueId: row.parentId,
        assigneeAgentId: row.assigneeAgentId, assigneeUserId: row.assigneeUserId },
    })));
  }
  const outcome = (decisions: Array<{ allowed: boolean; reason: string }>) => decisions.map(({ allowed, reason }) => ({ allowed, reason }));
  async function readableByBatch(actor: AuthorizationActor, ids: string[]) {
    const rows = await rowsFor(ids);
    const decisions = await authorizationService(ctx.db).decideReads({ ...actor }, rows.map((row) => resource(row)));
    return rows.filter((_, index) => decisions[index]!.allowed).map((row) => row.id);
  }

  function app(actor: AuthorizationActor, db = ctx.db) {
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => { req.actor = { ...actor } as Express.Request["actor"]; next(); });
    result.use("/api", issueRoutes(db, {} as never));
    result.use(errorHandler);
    return result;
  }
  function recording() {
    const statements: string[] = [];
    const db = drizzle(ctx.db.$client, {
      schema: ctx.db._.fullSchema, logger: { logQuery: (query) => statements.push(query) },
    }) as unknown as typeof ctx.db;
    return { db, statements };
  }
  const summariesUrl = (companyId: string) => `/api/companies/${companyId}/issues/summaries`;
  async function summaryIds(actor: AuthorizationActor, ids: string[], db = ctx.db) {
    const found: string[] = [];
    for (let offset = 0; offset < ids.length; offset += ISSUE_SUMMARIES_MAX_IDS) {
      const res = await request(app(actor, db)).get(summariesUrl(f.companyId))
        .query({ ids: ids.slice(offset, offset + ISSUE_SUMMARIES_MAX_IDS).join(",") });
      if (res.status !== 200) return { status: res.status, ids: [] as string[], body: JSON.stringify(res.body) };
      found.push(...(res.body as Array<{ id: string }>).map((row) => row.id));
    }
    return { status: 200, ids: found, body: "" };
  }

  it.each(ISSUE_READ_VISIBILITY_ACTORS)("decides every task read for %s exactly as one check per task does", async (name) => {
    const actor = f.actors[name];
    const rows = await rowsFor([...f.companyIssueIds, ...f.foreignIds]);
    expect(rows).toHaveLength(f.companyIssueIds.length + f.foreignIds.length);
    const batched = await authorizationService(ctx.db).decideReads({ ...actor }, rows.map((row) => resource(row)));
    expect(outcome(batched)).toEqual(outcome(await decideEachTask(actor, rows)));

    // Tasks of another company and IDs that do not exist, asked for as this company's.
    const foreign = await rowsFor(f.foreignIds);
    const claimed: Row[] = [...foreign, ...f.missingIds.map((id) => ({
      id, companyId: f.companyId, projectId: null, parentId: null, assigneeAgentId: null, assigneeUserId: null, status: "todo",
    }))];
    const claimedBatch = await authorizationService(ctx.db).decideReads({ ...actor }, claimed.map((row) => resource(row, f.companyId)));
    expect(outcome(claimedBatch)).toEqual(outcome(await decideEachTask(actor, claimed, f.companyId)));
  });

  it("keeps each kind of private task readable only by its principals", async () => {
    const privateIds = [...f.ownedPrivateIds, ...f.grantedPrivateIds, ...f.assignedPrivateIds, ...f.unreadablePrivateIds, ...f.privateProjectIssueIds];
    const readable = async (name: IssueReadVisibilityActorName) => (await readableByBatch(f.actors[name], privateIds)).sort();
    const sorted = (...groups: string[][]) => groups.flat().sort();
    expect(await readable("board owner")).toEqual(sorted(f.ownedPrivateIds));
    expect(await readable("cloud tenant owner")).toEqual(sorted(f.ownedPrivateIds));
    expect(await readable("board operator")).toEqual(sorted(f.grantedPrivateIds));
    expect(await readable("board admin")).toEqual(sorted(f.privateProjectIssueIds));
    // The viewer's grant is revoked and the member has none.
    expect(await readable("board viewer")).toEqual([]);
    expect(await readable("board member")).toEqual([]);
    expect(await readable("agent key")).toEqual(sorted(f.grantedPrivateIds));
    expect(await readable("assignee agent key")).toEqual(sorted(f.assignedPrivateIds));
    // An agent reads for a person only what both of them may read.
    expect(await readable("agent run for operator")).toEqual(sorted(f.grantedPrivateIds));
    expect(await readable("agent run for owner")).toEqual([]);
    expect(await readable("agent run for viewer")).toEqual([]);
    expect(await readable("instance admin")).toEqual(sorted(privateIds));
    expect(await readable("local implicit board")).toEqual(sorted(privateIds));
    for (const name of ["board without membership", "agent of another company", "unauthenticated"] as const) {
      expect(await readableByBatch(f.actors[name], f.companyIssueIds)).toEqual([]);
    }
    // A low-trust agent is denied open tasks outside its boundary, so its list is filtered row by row.
    const bounded = await readableByBatch(f.actors["low-trust agent bounded to a subtree"], f.publicIds);
    expect(bounded.sort()).toEqual([f.boundaryRootId, f.boundaryChildId].sort());
  });

  it.each(ISSUE_READ_VISIBILITY_ACTORS)("returns %s the summaries one check per task would, omitting the rest", async (name) => {
    const actor = f.actors[name];
    const result = await summaryIds(actor, f.allIds);
    const rows = await rowsFor(f.companyIssueIds.filter((id) => id !== f.hiddenId));
    const decisions = await decideEachTask(actor, rows);
    const expected = rows.filter((_, index) => decisions[index]!.allowed).map((row) => row.id);
    const rejected = REJECTED_BY_COMPANY_GATE[name];
    expect(result.status).toBe(rejected ?? 200);
    if (rejected) {
      for (const id of f.allIds) expect(result.body).not.toContain(id);
      return;
    }
    expect(result.ids).toEqual(f.allIds.filter((id) => expected.includes(id)));
    expect(result.ids.length).toBeGreaterThan(0);
    for (const id of [...f.foreignIds, ...f.missingIds, f.hiddenId]) expect(result.ids).not.toContain(id);
  });

  it.each([
    "low-trust agent bounded to tasks", "low-trust agent bounded to a subtree",
  ] as const)("lists for %s the tasks one check per task would", async (name) => {
    const actor = f.actors[name];
    const res = await request(app(actor)).get(`/api/companies/${f.companyId}/issues`).query({ limit: 500 }).expect(200);
    const listed = (res.body as Array<{ id: string }>).map((row) => row.id).sort();
    const rows = await rowsFor(f.companyIssueIds.filter((id) => id !== f.hiddenId));
    const decisions = await decideEachTask(actor, rows);
    expect(listed).toEqual(rows.filter((_, index) => decisions[index]!.allowed).map((row) => row.id).sort());
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(rows.length);
  });

  /** Statements of one summaries request for 5 tasks and of one for 50, each mixing every kind of task. */
  async function summaryStatements(name: IssueReadVisibilityActorName) {
    const actor = f.actors[name];
    // Both requests mix open tasks, a project task and readable and unreadable private tasks.
    const mixed = [f.publicIds[2]!, f.ownedPrivateIds[0]!, f.grantedPrivateIds[2]!, f.unreadablePrivateIds[1]!, f.publicIds[3]!];
    const many = [...mixed, ...f.ownedPrivateIds, ...f.grantedPrivateIds, ...f.assignedPrivateIds, ...f.unreadablePrivateIds,
      ...f.privateProjectIssueIds, ...f.foreignIds, ...f.missingIds, ...f.publicIds];
    const fifty = [...new Set(many)].slice(0, ISSUE_SUMMARIES_MAX_IDS);
    expect(fifty).toHaveLength(ISSUE_SUMMARIES_MAX_IDS);

    const small = recording();
    const five = await summaryIds(actor, mixed, small.db);
    const large = recording();
    const all = await summaryIds(actor, fifty, large.db);
    expect(five.status).toBe(200);
    expect(all.status).toBe(200);
    expect(all.ids.length).toBeGreaterThan(five.ids.length);
    return { small: small.statements, large: large.statements, extraTasks: fifty.length - mixed.length };
  }

  it.each([
    "board owner", "board viewer", "board key operator", "cloud tenant owner", "instance admin", "agent key",
    "assignee agent key", "agent run for operator", "agent authorized by operator",
  ] as const)("sends the same number of statements for %s whether a summaries request names 5 tasks or 50", async (name) => {
    const { small, large } = await summaryStatements(name);
    expect(large.filter((statement) => PER_TASK_PRIVACY_STATEMENT.test(statement))).toEqual([]);
    expect(large.length).toBe(small.length);
    expect(large.length).toBeLessThanOrEqual(16);
  });

  it.each([
    "low-trust agent bounded to tasks", "low-trust agent bounded to a subtree",
  ] as const)("adds only the boundary checks of each further task for %s", async (name) => {
    const { small, large, extraTasks } = await summaryStatements(name);
    // The task rows and the privacy predicate come from the batch. What stays
    // per task is the boundary itself: its ancestry walk and its mention grant.
    expect(large.filter((statement) => PER_TASK_PRIVACY_STATEMENT.test(statement))).toEqual([]);
    expect(large.filter((statement) => /from "issues" where \(?"issues"\."id" = \$1/.test(statement))).toEqual([]);
    expect(large.length).toBeLessThanOrEqual(small.length + 2 * extraTasks);
  });

  it("decides the per-task boundary checks of a batch a few at a time", async () => {
    let inFlight = 0, most = 0;
    const counting = new Proxy(ctx.db, {
      get(target, key) {
        if (key !== "execute") return Reflect.get(target, key);
        return (...args: Parameters<typeof target.execute>) => {
          most = Math.max(most, ++inFlight);
          return Promise.resolve(target.execute(...args)).finally(() => { inFlight -= 1; });
        };
      },
    });
    const actor = f.actors["low-trust agent bounded to a subtree"];
    const rows = await rowsFor(f.publicIds);
    const decisions = await authorizationService(counting).decideReads({ ...actor }, rows.map((row) => resource(row)));
    expect(rows.filter((_, index) => decisions[index]!.allowed).map((row) => row.id).sort())
      .toEqual([f.boundaryRootId, f.boundaryChildId].sort());
    // Each task outside the boundary walks its ancestry; they overlap, but never all at once.
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(READ_DECISION_CONCURRENCY);
  });

  it("does not let a batch reuse another actor's answer", async () => {
    // Two different actors over the same tasks in one process, in both orders.
    const ids = [...f.ownedPrivateIds, ...f.grantedPrivateIds, randomUUID()];
    const owner = (await summaryIds(f.actors["board owner"], ids)).ids;
    const operator = (await summaryIds(f.actors["board operator"], ids)).ids;
    expect(owner).toEqual(f.ownedPrivateIds);
    expect(operator).toEqual(f.grantedPrivateIds);
    expect((await summaryIds(f.actors["board owner"], ids)).ids).toEqual(owner);
  });
});
