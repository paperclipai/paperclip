import { createServer } from "node:http";
import { once } from "node:events";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { activityToastIdentity } from "../realtime/activity-toast-identity.js";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { publishLiveEvent } from "../services/live-events.js";
import { taskToastEligible } from "../realtime/task-toast-eligibility.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

vi.mock("../realtime/task-toast-eligibility.js", () => ({ taskToastEligible: vi.fn(async () => false) }));

vi.mock("../services/authorization.js", () => ({
  authorizationService: () => ({ decide: async ({ resource }: { resource: { issueId: string } }) => ({ allowed: resource.issueId !== "hidden" }) }),
}));
vi.mock("../services/heartbeat-run-privacy.js", () => ({
  getHeartbeatRunReadDecisions: async (_db: unknown, _access: unknown, _actor: unknown, runs: { issueId?: string }[]) =>
    runs.map(run => run.issueId !== "hidden"),
}));
vi.mock("../services/case-access.js", () => ({
  canActorReadCase: async (_db: unknown, _actor: unknown, record: { id: string }) => record.id !== "hidden-case",
}));
function database(onPredicate: (kind: "where" | "join", condition: SQL) => void = () => {}) {
  return { select: (fields: Record<string, unknown>) => {
    let table = "";
    const query = {
      from: (value: Parameters<typeof getTableName>[0]) => { table = getTableName(value); return query; },
      innerJoin: (_table: unknown, condition: SQL) => { onPredicate("join", condition); return query; },
      where: (condition: SQL) => { onPredicate("where", condition); return query; },
      limit: async () => {
        if (table === "issues") return [{ id: "task", identifier: "PAP-1234" }];
        if (table === "company_memberships") return fields.name ? [{ name: "Alex Example", image: "/alex.png" }] : [{ id: "membership" }];
        if (table === "agents") return [{ name: "Coder", appearance: { schemaVersion: 1, characterVersion: "cap-v1", paletteId: "bubblegum-sky" } }];
        return [];
      },
    };
    return query;
  } };
}
describe("authenticated activity notifications", () => {
  it("retains live delivery idle work until the identifier read settles after the last socket closes", async () => {
    const baseline = idleWorkSnapshot().active;
    let release!: () => void, entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const db = database(), select = db.select;
    db.select = fields => {
      const query = select(fields);
      if (fields.identifier) {
        const limit = query.limit;
        query.limit = async () => { entered(); await pending; return limit(); };
      }
      return query;
    };
    const server = createServer();
    const wss = setupLiveEventsWebSocketServer(server, db as never, { deploymentMode: "local_trusted" });
    const closed = new Promise<void>(resolve => wss.on("connection", socket => socket.on("close", resolve)));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/companies/company/events/ws`);
    try {
      await once(socket, "open");
      await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(baseline));
      // System activity has no actor lookup: this gate is the new identifier SQL.
      publishLiveEvent({ companyId: "company", type: "activity.logged", payload: {
        action: "issue.updated", entityType: "issue", entityId: "visible", actorType: "system",
      } });
      await started;
      socket.terminate();
      await closed;
      expect(wss.clients.size).toBe(0);
      expect(idleWorkSnapshot().active).toBe(baseline + 1);
      release();
      await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(baseline));
    } finally {
      release();
      socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(baseline));
    }
  });

  it.each(["local_trusted", "authenticated"] as const)("keeps authorized notifications when optional identifier reads fail (%s)", async deploymentMode => {
    const db = database();
    const select = db.select;
    const identifierRead = vi.fn();
    db.select = fields => {
      if (fields.identifier) {
        identifierRead();
        if (identifierRead.mock.calls.length <= 3) throw new Error("Identifier lookup unavailable");
      }
      return select(fields);
    };
    const server = createServer();
    setupLiveEventsWebSocketServer(server, db as never, { deploymentMode,
      resolveCloudActor: async () => ({ userId: "viewer", companyIds: ["company"] }) });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/companies/company/events/ws`);
    try {
      await once(socket, "open");
      const messages: Array<{ payload: Record<string, unknown> }> = [];
      const delivered = new Promise<void>(resolve => socket.on("message", data => {
        const event = JSON.parse(data.toString());
        messages.push(event);
        if (event.payload.entityId === "after-failure") resolve();
      }));
      const activity = (entityId: string, actorType: string) => publishLiveEvent({
        companyId: "company", type: "activity.logged", payload: {
          action: "issue.updated", entityType: "issue", entityId, actorType,
          actorId: actorType === "user" ? "viewer" : actorType === "agent" ? "agent" : null,
          issueIdentifier: "SPOOF-1", details: { secret: "private task details" },
        },
      });
      if (deploymentMode === "authenticated") activity("hidden", "system");
      for (const actorType of ["system", "agent", "user"]) {
        activity("visible", actorType);
      }
      activity("after-failure", "system");
      await delivered;
      expect(messages).toHaveLength(4);
      expect(identifierRead).toHaveBeenCalledTimes(4);
      for (const [index, actorType] of ["system", "agent", "user"].entries()) {
        const event = messages[index];
        expect(event.payload).toMatchObject({ entityId: "visible", actorType, issueIdentifier: null });
        if (actorType === "agent") expect(event.payload.actorName).toBe("Coder");
        if (actorType === "user") expect(event.payload.actorName).toBe("Alex Example");
        if (deploymentMode === "authenticated") expect(event.payload).not.toHaveProperty("details");
        // Routine updates are not task identity changes.
        expect(event.payload.taskIdentityChanged).toBe(false);
      }
      expect(messages[3].payload.issueIdentifier).toBe("PAP-1234");
    } finally {
      socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("preserves only an authorized handoff task identity for empty case-panel refresh", async () => {
    const server = createServer();
    setupLiveEventsWebSocketServer(server, database() as never, { deploymentMode: "authenticated",
      resolveCloudActor: async () => ({ userId: "viewer", companyIds: ["company"] }) });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/companies/company/events/ws`);
    try {
      await once(socket, "open");
      const messages: Array<{ payload: Record<string, unknown> }> = [];
      socket.on("message", data => messages.push(JSON.parse(data.toString())));
      const activity = (entityId: string, issueId: string, action = "case.handoff_applied") => publishLiveEvent({
        companyId: "company", type: "activity.logged", payload: {
          action, entityType: "case", entityId, issueId,
          details: { instructions: "private handoff instructions", phase: "verification" },
        },
      });
      activity("hidden-case", "visible");
      activity("visible-case", "hidden");
      const first = once(socket, "message");
      activity("visible-case", "visible");
      await first;
      expect(messages).toHaveLength(1);
      expect(messages[0].payload).toEqual({ action: "case.handoff_applied", entityType: "case", entityId: "visible-case", issueId: "visible", actorType: null, actorId: null });
      const second = once(socket, "message");
      activity("visible-case", "visible", "case.updated");
      await second;
      expect(messages[1].payload).toEqual({ action: "case.updated", entityType: "case", entityId: "visible-case", actorType: null, actorId: null });
    } finally {
      socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("uses the persisted local-board user identity for local task eligibility", async () => {
    vi.mocked(taskToastEligible).mockImplementation(async (_db, _event, userId) => userId === "local-board");
    const server = createServer();
    setupLiveEventsWebSocketServer(server, database() as never, { deploymentMode: "local_trusted" });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/companies/company/events/ws`);
    try {
      await once(socket, "open");
      const delivery = once(socket, "message");
      publishLiveEvent({ companyId: "company", type: "activity.logged", payload: {
        action: "issue.updated", entityType: "issue", entityId: "visible", actorType: "agent", actorId: "agent",
      } });
      const [data] = await delivery;
      expect(JSON.parse(data.toString()).toastEligible).toBe(true);
      expect(JSON.parse(data.toString()).payload.issueIdentifier).toBe("PAP-1234");
      expect(taskToastEligible).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "local-board");
    } finally {
      socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.mocked(taskToastEligible).mockReset().mockResolvedValue(false);
    }
  });

  it("projects eligibility per viewer and keeps authorized updates on lookup failure", async () => {
    vi.mocked(taskToastEligible).mockImplementation(async (_db, event, userId) => {
      if (event.payload.entityId === "lookup-failure") throw new Error("Relevance unavailable");
      return userId === "alice";
    });
    const server = createServer();
    setupLiveEventsWebSocketServer(server, database() as never, {
      deploymentMode: "authenticated",
      resolveCloudActor: async (req) => ({ userId: String(req.headers["x-test-viewer"]), companyIds: ["company"] }),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/companies/company/events/ws`;
    const alice = new WebSocket(url, { headers: { "x-test-viewer": "alice" } });
    const bob = new WebSocket(url, { headers: { "x-test-viewer": "bob" } });
    try {
      await Promise.all([once(alice, "open"), once(bob, "open")]);
      for (const entityId of ["visible", "lookup-failure"]) {
        const deliveries = Promise.all([once(alice, "message"), once(bob, "message")]);
        const original = publishLiveEvent({ companyId: "company", type: "activity.logged", payload: {
          action: "issue.comment_added", entityType: "issue", entityId, actorType: "agent", actorId: "agent",
        } });
        const [a, b] = (await deliveries).map(([data]) => JSON.parse(data.toString()));
        expect(a.toastEligible).toBe(entityId === "visible");
        expect(b.toastEligible).toBe(false);
        expect(a.payload.entityId).toBe(entityId);
        expect(b.payload.entityId).toBe(entityId);
        expect(a.payload.issueIdentifier).toBe("PAP-1234");
        expect(b.payload.issueIdentifier).toBe("PAP-1234");
        expect(original).not.toHaveProperty("toastEligible");
      }
    } finally {
      alice.terminate(); bob.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.mocked(taskToastEligible).mockReset().mockResolvedValue(false);
    }
  });

  it.each(["authenticated", "local_trusted"] as const)("keeps task and actor identity for %s without exposing hidden tasks or copying private details", async (deploymentMode) => {
    const server = createServer();
    setupLiveEventsWebSocketServer(server, database() as never, { deploymentMode,
      resolveCloudActor: async () => ({ userId: "viewer", companyIds: ["company"] }) });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/companies/company/events/ws`);
    try {
      await once(socket, "open");
      const messages: Array<{ payload: Record<string, unknown> }> = [];
      socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
      const activity = (entityId: string, actorType = "user") => publishLiveEvent({ companyId: "company", type: "activity.logged", payload: {
        action: "issue.created", entityType: "issue", entityId, actorType, actorId: actorType === "user" ? "viewer" : "agent",
        issueIdentifier: "SPOOF-1",
        details: { bodySnippet: "private comment", secret: "not for the socket" },
      } });
      if (deploymentMode === "authenticated") activity("hidden");
      const first = once(socket, "message");
      activity("visible");
      await first;
      expect(messages).toHaveLength(1);
      expect(messages[0].payload).toMatchObject({ action: "issue.created", entityType: "issue", entityId: "visible", issueIdentifier: "PAP-1234", actorType: "user", actorId: "viewer", actorName: "Alex Example", actorImage: "/alex.png" });
      if (deploymentMode === "authenticated") expect(messages[0].payload).not.toHaveProperty("details");
      const second = once(socket, "message");
      activity("visible", "agent");
      await second;
      expect(messages[1].payload).toMatchObject({ issueIdentifier: "PAP-1234", actorName: "Coder", actorType: "agent", actorId: "agent", actorAppearance: { paletteId: "bubblegum-sky" } });
      if (deploymentMode === "authenticated") expect(messages[1].payload).not.toHaveProperty("details");
      expect(messages[0].payload.taskIdentityChanged).toBe(true);
      const third = once(socket, "message");
      publishLiveEvent({ companyId: "company", type: "activity.logged", payload: {
        action: "issue.updated", entityType: "issue", entityId: "visible", actorType: "user", actorId: "viewer",
        details: { title: "Secret new title", hiddenAt: null },
      } });
      await third;
      // A rename or hide is flagged with a closed boolean; its content stays off the socket.
      expect(messages[2].payload.taskIdentityChanged).toBe(true);
      if (deploymentMode === "authenticated") expect(JSON.stringify(messages[2].payload)).not.toContain("Secret new title");
    } finally {
      socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});


describe("activity profile query boundaries", () => {
  it("reads the task identifier within its company even when there is no actor", async () => {
    const predicates: { sql: string; params: unknown[] }[] = [];
    const db = database((_kind, condition) => {
      const { sql, params } = new PgDialect().sqlToQuery(condition);
      predicates.push({ sql, params });
    });
    expect(await activityToastIdentity(db as never, "company-A", {
      action: "issue.updated", entityType: "issue", entityId: "task-A", actorType: "system",
    })).toMatchObject({ issueIdentifier: "PAP-1234" });
    expect(predicates).toEqual([
      { sql: '("issues"."company_id" = $1 and "issues"."id" = $2)', params: ["company-A", "task-A"] },
    ]);
  });

  it("requires the exact company, human actor, and active membership before reading a person profile", async () => {
    const predicates: { kind: string; sql: string; params: unknown[] }[] = [];
    const db = database((kind, condition) => {
      const { sql, params } = new PgDialect().sqlToQuery(condition);
      predicates.push({ kind, sql, params });
    });
    await activityToastIdentity(db as never, "company-A", {
      action: "issue.created", actorType: "user", actorId: "person-A",
    });
    expect(predicates).toEqual([
      { kind: "join", sql: '"user"."id" = "company_memberships"."principal_id"', params: [] },
      { kind: "where", sql: '("company_memberships"."company_id" = $1 and "company_memberships"."principal_type" = $2 and "company_memberships"."principal_id" = $3 and "company_memberships"."status" = $4)',
        params: ["company-A", "user", "person-A", "active"] },
    ]);
  });

  it("requires both the exact company and agent ID before reading an agent profile", async () => {
    const predicates: { kind: string; sql: string; params: unknown[] }[] = [];
    const db = database((kind, condition) => {
      const { sql, params } = new PgDialect().sqlToQuery(condition);
      predicates.push({ kind, sql, params });
    });
    await activityToastIdentity(db as never, "company-A", {
      action: "issue.created", actorType: "agent", actorId: "agent-A",
    });
    expect(predicates).toEqual([
      { kind: "where", sql: '("agents"."company_id" = $1 and "agents"."id" = $2)',
        params: ["company-A", "agent-A"] },
    ]);
  });
});
