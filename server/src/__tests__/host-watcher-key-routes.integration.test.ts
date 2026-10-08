import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import express from "express";
import request from "supertest";
import WebSocket from "ws";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentApiKeys, agents, authUsers, companies, companyMemberships, createDb,
  heartbeatRuns, issueComments, issueExecutionDecisions, issues, principalPermissionGrants, projects,
} from "@paperclipai/db";
import type { CronServiceAgentKeyScope, HostWatcherAgentKeyScope } from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { HOST_WATCHER_COMMENT_LIMIT_PER_HOUR, cronServiceKeyGuard, hostWatcherKeyGuard } from "../middleware/cron-service-key.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { agentService } from "../services/agents.js";
import { issueService } from "../services/issues.js";
import { publishLiveEvent } from "../services/live-events.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Mutations exercise real issue routes and DB writes; the test never starts a
// fixture agent process as a side effect of a wake.
vi.mock("../services/heartbeat.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/heartbeat.js")>()),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => null),
    getRun: async () => null,
    getActiveRunForAgent: async () => null,
    cancelActiveForAgent: vi.fn(async () => undefined),
  }),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

const supported = await getEmbeddedPostgresTestSupport();
const describeDb = supported.supported ? describe : describe.skip;
const companyId = "ac917a45-e6ea-4696-a85c-991147084939";
const fleetProjectId = "dce756cc-51b5-4ed1-9fed-57596f6b3eb8";
const watchdogAlarmIssueId = "95f08a55-6b5c-4183-b3de-5f151818607d";
const watchdogRecoverAgentId = "b98de8dc-9e6e-4f2a-8c19-2202b4720675";
const targets = {
  disk: { issueId: "f6775544-fb1c-4380-906c-66e4f5fb7028", assigneeAgentId: "5549a5f4-935d-43a5-a90d-d452d77dd1ea" },
  pr923: { issueId: "9118f56f-3e9c-48e1-86b8-dea7488cfe71", assigneeAgentId: "1e95ea6e-1965-4df3-8a3b-4bb26b5231f1" },
  be1198: { issueId: "94118e6a-ac24-4b15-b35b-3123310ff219", assigneeAgentId: "c281b1e9-fa48-4f67-aed0-e8f8757c5b61" },
  fe1042: { issueId: "02af846b-1399-4ba0-ba47-12831bb39024", assigneeAgentId: "fcd82af7-5cf9-48b8-b361-e43d9d9eaf17" },
  fleet: { issueId: "3018b33b-1cf0-4255-9820-617915f8099e", assigneeAgentId: "022bea41-031e-4beb-a38d-4efc9c49ff23" },
} as const;

const scopes: Record<string, HostWatcherAgentKeyScope> = {
  disk: { kind: "host_watcher", service: "disk_guard", ...targets.disk },
  pr923: { kind: "host_watcher", service: "pr_923", ...targets.pr923 },
  be1198: { kind: "host_watcher", service: "be_1198", ...targets.be1198 },
  fe1042: { kind: "host_watcher", service: "fe_1042", ...targets.fe1042 },
  fleet: { kind: "host_watcher", service: "fleet_hourly", ...targets.fleet, projectId: fleetProjectId },
};
const cronScopes: Record<string, CronServiceAgentKeyScope> = {
  watchdog: { kind: "cron_service", service: "agent_watchdog", alarmIssueIds: [watchdogAlarmIssueId] },
  quota: { kind: "cron_service", service: "quota_rewake" },
};

describeDb("seven host service keys on real issue routes and test DB", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let app: express.Express;
  const tokens: Record<string, string> = {};
  const serviceAgents: Record<string, string> = {};
  const responsibleUserId = "host-watcher-fixture-user";
  let afterWatchdogGuard: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("host-watcher-key-routes-");
    db = createDb(temporary.connectionString);
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "host-watcher-test-only-signing-secret";
    await db.insert(companies).values({ id: companyId, name: "Host watcher fixture", issuePrefix: "HWT", issueCounter: 20 });
    await db.insert(authUsers).values({
      id: responsibleUserId, name: "Fixture owner", email: "host-watcher@example.test",
      createdAt: new Date(), updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: responsibleUserId,
      status: "active", membershipRole: "owner",
    });
    await db.insert(projects).values({ id: fleetProjectId, companyId, name: "Fleet fixture" });
    const targetAgentIds = [...Object.values(targets).map((target) => target.assigneeAgentId), watchdogRecoverAgentId];
    for (const [name, scope] of Object.entries({ ...scopes, ...cronScopes })) {
      const serviceAgentId = randomUUID();
      serviceAgents[name] = serviceAgentId;
      tokens[name] = `pc_host_fixture_${name}`;
      await db.insert(agents).values({
        id: serviceAgentId, companyId, name: `Service ${name}`,
        adapterType: "process", adapterConfig: {}, runtimeConfig: {}, status: "idle",
      });
      await db.insert(agentApiKeys).values({
        agentId: serviceAgentId, companyId, name,
        keyHash: createHash("sha256").update(tokens[name]!).digest("hex"),
        responsibleUserId, scopeConfig: scope,
      });
    }
    await db.insert(agents).values(targetAgentIds.map((id) => ({
      id, companyId, name: `Target ${id.slice(0, 8)}`,
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, status: "idle" as const,
    })));
    await db.insert(principalPermissionGrants).values(["agents:configure", "agents:create"].map((permissionKey) => ({
      companyId, principalType: "user" as const, principalId: responsibleUserId, permissionKey,
    })));
    const fixtureIssues = [targets.disk, targets.pr923, targets.be1198, targets.fe1042, targets.fleet];
    await db.insert(issues).values(fixtureIssues.map((target, index) => ({
      id: target.issueId, companyId, issueNumber: index + 1, identifier: `HWT-${index + 1}`,
      title: `Fixture target ${index + 1}`,
      status: index === 4 ? "backlog" : "blocked",
      assigneeAgentId: index === 4 ? null : target.assigneeAgentId,
      projectId: index === 4 ? fleetProjectId : null,
    })));
    await db.insert(issues).values({
      id: watchdogAlarmIssueId, companyId, issueNumber: 6, identifier: "HWT-6",
      title: "Fixed watchdog alarm", status: "in_progress",
      assigneeAgentId: targets.disk.assigneeAgentId,
      executionPolicy: { mode: "normal", stages: [] },
    });
    app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async (req) => req.header("x-test-board-session") === "pause"
        ? {
            session: { id: "fixture-board-session", userId: responsibleUserId },
            user: { id: responsibleUserId, name: "Fixture owner", email: "host-watcher@example.test" },
          }
        : null,
    }));
    app.use(hostWatcherKeyGuard(db));
    app.use(cronServiceKeyGuard(db));
    app.use(async (req, _res, next) => {
      if (req.method !== "PATCH" || ![
        `/api/agents/${watchdogRecoverAgentId}`,
        `/api/issues/${watchdogAlarmIssueId}`,
      ].includes(req.path)
        || req.actor.type !== "agent" || req.actor.keyScope?.kind !== "cron_service"
        || !afterWatchdogGuard) return next();
      try {
        await afterWatchdogGuard();
        next();
      } catch (error) {
        next(error);
      }
    });
    app.use("/api", agentRoutes(db, { deploymentMode: "authenticated" }));
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }).catch(() => {});
    await temporary?.cleanup();
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  });

  function auth(name: string) {
    return `Bearer ${tokens[name]}`;
  }

  it("watchdog can comment on and rearm its fixed alarm, but cannot touch a foreign issue", async () => {
    const url = `/api/issues/${watchdogAlarmIssueId}`;
    const allowedComment = await request(app).post(`${url}/comments`)
      .set("Authorization", auth("watchdog")).send({ body: "Fixed alarm observation" });
    expect(allowedComment.status, JSON.stringify(allowedComment.body)).toBe(201);
    const monitor = {
      kind: "external_service", serviceName: "paperclip-board", recoveryPolicy: "wake_owner",
      maxAttempts: 100, nextCheckAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    const rearmed = await request(app).patch(url).set("Authorization", auth("watchdog"))
      .send({ executionPolicy: { mode: "normal", stages: [], monitor } });
    expect(rearmed.status, JSON.stringify(rearmed.body)).toBe(200);
    expect((await request(app).post(`/api/issues/${targets.disk.issueId}/comments`)
      .set("Authorization", auth("watchdog")).send({ body: "foreign alarm" })).status).toBe(403);
    expect((await request(app).get(`/api/agents/${serviceAgents.quota}/keys`)
      .set("Authorization", auth("watchdog"))).status).toBe(403);
    await db.update(agents).set({ status: "error" }).where(eq(agents.id, watchdogRecoverAgentId));
    expect((await request(app).get(`/api/companies/${companyId}/agents`)
      .set("Authorization", auth("watchdog"))).status).toBe(200);
    const recovered = await request(app).patch(`/api/agents/${watchdogRecoverAgentId}`)
      .set("Authorization", auth("watchdog")).send({ status: "idle" });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect((await request(app).patch(`/api/agents/${watchdogRecoverAgentId}`)
      .set("Authorization", auth("watchdog")).send({ status: "terminated" })).status).toBe(403);
  });

  it("keeps board review and authorization edits made after the watchdog scope guard", async () => {
    const path = `/api/issues/${watchdogAlarmIssueId}`;
    const [baseline] = await db.select().from(issues).where(eq(issues.id, watchdogAlarmIssueId));
    expect(baseline).toBeDefined();
    const originalPolicy = baseline!.executionPolicy as Record<string, unknown>;
    const monitor = {
      kind: "external_service", serviceName: "paperclip-board", recoveryPolicy: "wake_owner",
      maxAttempts: 100, nextCheckAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    };
    let reachedGuard = false;
    let releasePatch!: () => void;
    const held = new Promise<void>((resolve) => { releasePatch = resolve; });
    afterWatchdogGuard = async () => {
      reachedGuard = true;
      await held;
    };
    const pending = request(app).patch(path).set("Authorization", auth("watchdog"))
      .send({ executionPolicy: { ...originalPolicy, monitor } }).then((response) => response);
    try {
      await vi.waitFor(() => expect(reachedGuard).toBe(true), { timeout: 5_000 });
      const { monitor: _previousMonitor, ...policyWithoutMonitor } = originalPolicy;
      const boardPolicy = {
        ...policyWithoutMonitor,
        stages: [{
          id: randomUUID(), type: "review", participants: [{
            id: randomUUID(), type: "user", userId: responsibleUserId,
          }],
        }],
        authorizationPolicy: { assignmentPolicy: { mode: "protected" } },
      };
      const boardEdit = await request(app).patch(path).set("x-test-board-session", "pause")
        .send({ executionPolicy: boardPolicy });
      expect(boardEdit.status, JSON.stringify(boardEdit.body)).toBe(200);
      releasePatch();
      afterWatchdogGuard = null;
      const stale = await pending;
      expect(stale.status, JSON.stringify(stale.body)).toBe(409);
      const [afterStale] = await db.select({ executionPolicy: issues.executionPolicy })
        .from(issues).where(eq(issues.id, watchdogAlarmIssueId));
      expect(afterStale!.executionPolicy).toMatchObject({
        stages: [{ type: "review" }],
        authorizationPolicy: { assignmentPolicy: { mode: "protected" } },
      });

      const rearmed = await request(app).patch(path).set("Authorization", auth("watchdog"))
        .send({ executionPolicy: { ...afterStale!.executionPolicy, monitor } });
      expect(rearmed.status, JSON.stringify(rearmed.body)).toBe(200);
      const [afterRearm] = await db.select({ executionPolicy: issues.executionPolicy })
        .from(issues).where(eq(issues.id, watchdogAlarmIssueId));
      expect(afterRearm!.executionPolicy).toMatchObject({
        stages: [{ type: "review" }],
        authorizationPolicy: { assignmentPolicy: { mode: "protected" } },
        monitor: { nextCheckAt: monitor.nextCheckAt },
      });
    } finally {
      releasePatch();
      afterWatchdogGuard = null;
      await pending.catch(() => {});
      await db.update(issues).set({
        status: baseline!.status,
        assigneeAgentId: baseline!.assigneeAgentId,
        assigneeUserId: baseline!.assigneeUserId,
        executionPolicy: baseline!.executionPolicy,
        executionState: baseline!.executionState,
        monitorNextCheckAt: baseline!.monitorNextCheckAt,
        monitorWakeRequestedAt: baseline!.monitorWakeRequestedAt,
        monitorNotes: baseline!.monitorNotes,
        monitorScheduledBy: baseline!.monitorScheduledBy,
        monitorAttemptCount: baseline!.monitorAttemptCount,
      }).where(eq(issues.id, watchdogAlarmIssueId));
    }
  });

  it.each(["offline", "crashed"] as const)("recovers a %s agent through the watchdog route", async (status) => {
    await db.update(agents).set({ status }).where(eq(agents.id, watchdogRecoverAgentId));
    const recovered = await request(app).patch(`/api/agents/${watchdogRecoverAgentId}`)
      .set("Authorization", auth("watchdog")).send({ status: "idle" });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    const [current] = await db.select({ status: agents.status }).from(agents)
      .where(eq(agents.id, watchdogRecoverAgentId));
    expect(current?.status).toBe("idle");
  });

  it.each(["manual", "budget"] as const)("preserves a %s pause made after the watchdog scope guard", async (reason) => {
    const path = `/api/agents/${watchdogRecoverAgentId}`;
    await db.update(agents).set({ status: "error", pauseReason: null, pausedAt: null })
      .where(eq(agents.id, watchdogRecoverAgentId));
    let reachedGuard = false;
    let releasePatch!: () => void;
    const held = new Promise<void>((resolve) => { releasePatch = resolve; });
    afterWatchdogGuard = async () => {
      reachedGuard = true;
      await held;
    };
    const patch = request(app).patch(path).set("Authorization", auth("watchdog"))
      .send({ status: "idle" }).then((response) => response);
    try {
      await vi.waitFor(() => expect(reachedGuard).toBe(true), { timeout: 5_000 });
      if (reason === "manual") {
        const paused = await request(app).post(`${path}/pause`).set("x-test-board-session", "pause");
        expect(paused.status, JSON.stringify(paused.body)).toBe(200);
      } else {
        const paused = await agentService(db).pause(watchdogRecoverAgentId, "budget");
        expect(paused?.status).toBe("paused");
      }
    } finally {
      releasePatch();
      afterWatchdogGuard = null;
    }
    const response = await patch;
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    const [current] = await db.select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents).where(eq(agents.id, watchdogRecoverAgentId));
    expect(current).toMatchObject({ status: "paused", pauseReason: reason });
  });

  it("denies watchdog recovery of an agent in another company", async () => {
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Foreign fixture", issuePrefix: "FRA" });
    await db.insert(agents).values({
      id: otherAgentId, companyId: otherCompanyId, name: "Foreign agent",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, status: "error",
    });
    const response = await request(app).patch(`/api/agents/${otherAgentId}`)
      .set("Authorization", auth("watchdog")).send({ status: "idle" });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    const [current] = await db.select({ status: agents.status }).from(agents)
      .where(eq(agents.id, otherAgentId));
    expect(current?.status).toBe("error");
  });

  it("quota can create a scoped nudge and cannot act on a foreign issue", async () => {
    const path = `/api/companies/${companyId}/issues`;
    const body = {
      title: "[quota-rewake] fixture: return", description: "quota restored",
      status: "todo", priority: "high", assigneeAgentId: targets.disk.assigneeAgentId,
    };
    const allowed = await request(app).post(path).set("Authorization", auth("quota")).send(body);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    expect((await request(app).post(path).set("Authorization", auth("quota"))
      .send({ ...body, title: "unrelated order" })).status).toBe(403);
    expect((await request(app).get(`/api/issues/${targets.disk.issueId}`)
      .set("Authorization", auth("quota"))).status).toBe(403);
    expect((await request(app).post(`/api/issues/${targets.disk.issueId}/comments`)
      .set("Authorization", auth("quota")).send({ body: "foreign comment" })).status).toBe(403);
  });

  it.skipIf(!process.env.PAPERCLIP_HOST_UID_HTTP_PROBE)("runs seven private UID credentials through real HTTP routes", async () => {
    const fixtureDir = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "hela14382-uid-http-"));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("UID HTTP fixture has no port");
    const issue = (id: string) => `/api/issues/${id}`;
    const foreignIssue = issue(targets.disk.issueId);
    const names = {
      "pc-cron-watchdog": "watchdog",
      "pc-disk-guard": "disk",
      "pc-watch-12320": "pr923",
      "pc-watch-12340": "be1198",
      "pc-watch-12359": "fe1042",
      "pc-cron-quota": "quota",
      "pc-fleet-watch": "fleet",
    } as const;
    const manifest = {
      origin: `http://127.0.0.1:${address.port}`,
      services: {
        "pc-cron-watchdog": {
          allowed: { method: "POST", path: `${issue(watchdogAlarmIssueId)}/comments`,
            body: { body: "UID watchdog observation" }, status: 201 },
          denied: { method: "POST", path: `${foreignIssue}/comments`,
            body: { body: "foreign alarm" }, status: 403 },
        },
        "pc-disk-guard": {
          allowed: { method: "PATCH", path: foreignIssue,
            body: { status: "todo", comment: "UID disk signal" }, status: 200 },
          denied: { method: "POST", path: `${foreignIssue}/comments`,
            body: { body: "wrong method" }, status: 403 },
        },
        "pc-watch-12320": {
          allowed: { method: "GET", path: issue(targets.pr923.issueId), status: 200 },
          denied: { method: "GET", path: foreignIssue, status: 403 },
        },
        "pc-watch-12340": {
          allowed: { method: "GET", path: issue(targets.be1198.issueId), status: 200 },
          denied: { method: "GET", path: foreignIssue, status: 403 },
        },
        "pc-watch-12359": {
          allowed: { method: "GET", path: issue(targets.fe1042.issueId), status: 200 },
          denied: { method: "GET", path: foreignIssue, status: 403 },
        },
        "pc-cron-quota": {
          allowed: { method: "POST", path: `/api/companies/${companyId}/issues`,
            body: { title: "[quota-rewake] UID fixture: return", description: "quota restored",
              status: "todo", priority: "high", assigneeAgentId: targets.disk.assigneeAgentId }, status: 201 },
          denied: { method: "GET", path: foreignIssue, status: 403 },
        },
        "pc-fleet-watch": {
          allowed: { method: "POST", path: `${issue(targets.fleet.issueId)}/comments`,
            body: { body: "UID fleet observation" }, status: 201 },
          denied: { method: "GET", path: issue(targets.fleet.issueId), status: 403 },
        },
      },
      agentDenied: { method: "GET", path: foreignIssue, status: 401 },
    };
    const packageDir = join(process.cwd(), "ops/cron-service/board-watchers");
    try {
      for (const [uid, name] of Object.entries(names)) {
        await writeFile(join(fixtureDir, `${uid}.token`), `${tokens[name]}\n`, { mode: 0o600 });
      }
      await writeFile(join(fixtureDir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
      const { stdout } = await promisify(execFile)("docker", [
        "run", "--rm", "--network", "host",
        "--mount", `type=bind,src=${packageDir},dst=/package,readonly`,
        "--mount", `type=bind,src=${fixtureDir},dst=/root/fixture,readonly`,
        "python:3.12-alpine", "sh", "-c",
        "mkdir -p /opt/paperclip-cron && cp /package/probe_uid_fixture.py /package/service_http.py /package/verify_boundary.py /opt/paperclip-cron/ && exec python3 /opt/paperclip-cron/probe_uid_fixture.py /root/fixture",
      ], { timeout: 90_000 });
      for (const [uid, action] of Object.entries(manifest.services)) {
        expect(stdout).toContain(`${uid}: allowed=${action.allowed.status} denied=${action.denied.status}`);
      }
      expect(stdout).toContain("uid1000: denied=401");
      expect(stdout).toContain("42 cross-source reads denied");
    } finally {
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, targets.disk.issueId));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 90_000);

  it("keeps host watcher keys out of company-wide WebSocket events", async () => {
    const standardAgentId = randomUUID();
    const standardToken = "pc_standard_websocket_fixture";
    const unsupportedToken = "pc_unsupported_websocket_fixture";
    await db.insert(agents).values({
      id: standardAgentId, companyId, name: "Standard WebSocket fixture",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, status: "idle",
    });
    await db.insert(agentApiKeys).values({
      agentId: standardAgentId, companyId, name: "standard websocket",
      keyHash: createHash("sha256").update(standardToken).digest("hex"),
      responsibleUserId, scopeConfig: null,
    });
    await db.insert(agentApiKeys).values({
      agentId: standardAgentId, companyId, name: "unsupported websocket scope",
      keyHash: createHash("sha256").update(unsupportedToken).digest("hex"),
      responsibleUserId, scopeConfig: { kind: "future_scope" } as never,
    });

    const server = createServer(app);
    const wss = setupLiveEventsWebSocketServer(server, db, { deploymentMode: "authenticated" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("WebSocket fixture has no port");
    const url = `ws://127.0.0.1:${address.port}/api/companies/${companyId}/events/ws`;
    let standardSocket: WebSocket | null = null;

    const rejectedStatus = (socketUrl: string, headers?: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(socketUrl, { headers });
        socket.once("unexpected-response", (_request, response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        socket.once("open", () => {
          socket.close();
          reject(new Error("A scoped key opened the company-wide WebSocket"));
        });
        socket.once("error", reject);
      });

    try {
      expect(await rejectedStatus(url, { Authorization: auth("disk") })).toBe(403);
      expect(await rejectedStatus(`${url}?token=${encodeURIComponent(tokens.fleet!)}`)).toBe(403);
      expect(await rejectedStatus(url, { Authorization: auth("watchdog") })).toBe(403);
      expect(await rejectedStatus(url, { Authorization: `Bearer ${unsupportedToken}` })).toBe(403);

      standardSocket = new WebSocket(url, { headers: { Authorization: `Bearer ${standardToken}` } });
      await new Promise<void>((resolve, reject) => {
        standardSocket!.once("open", resolve);
        standardSocket!.once("error", reject);
      });
      const received = new Promise<Record<string, unknown>>((resolve, reject) => {
        standardSocket!.once("message", (data) => {
          try {
            resolve(JSON.parse(data.toString()) as Record<string, unknown>);
          } catch (error) {
            reject(error);
          }
        });
        standardSocket!.once("error", reject);
      });
      const commentId = randomUUID();
      publishLiveEvent({
        companyId, type: "activity.logged",
        payload: {
          action: "issue.comment_added", entityType: "issue", entityId: targets.pr923.issueId,
          issueId: targets.pr923.issueId, details: { commentId, body: "private issue comment" },
          bodySnippet: "private issue comment",
        },
      });
      const event = await received;
      expect(event).toMatchObject({
        companyId, payload: {
          action: "issue.comment_added", entityType: "issue", entityId: targets.pr923.issueId,
          details: { commentId },
        },
      });
      expect(event.payload).not.toHaveProperty("issueId");
      expect(event.payload).not.toHaveProperty("bodySnippet");
      expect(event.payload.details).not.toHaveProperty("body");
    } finally {
      standardSocket?.terminate();
      await new Promise<void>((resolve) => wss.close(resolve));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("disk guard can signal its issue and cannot change another field, method or target", async () => {
    const url = `/api/issues/${targets.disk.issueId}`;
    const allowed = await request(app).patch(url).set("Authorization", auth("disk"))
      .send({ status: "todo", comment: "Disk pressure reached the fixed threshold" });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect((await request(app).patch(url).set("Authorization", auth("disk"))
      .send({ status: "todo", comment: "signal", assigneeAgentId: targets.fleet.assigneeAgentId })).status).toBe(403);
    expect((await request(app).post(`${url}/comments`).set("Authorization", auth("disk"))
      .send({ body: "wrong method" })).status).toBe(403);
    expect((await request(app).patch(`/api/issues/${targets.pr923.issueId}`).set("Authorization", auth("disk"))
      .send({ status: "todo", comment: "wrong issue" })).status).toBe(403);
  });

  it.each([
    ["pr923", targets.pr923.issueId, "todo"],
    ["be1198", targets.be1198.issueId, "in_progress"],
    ["fe1042", targets.fe1042.issueId, "in_progress"],
  ] as const)("%s can read/comment and perform only its blocked transition", async (name, issueId, status) => {
    const url = `/api/issues/${issueId}`;
    expect((await request(app).get(url).set("Authorization", auth(name))).status).toBe(200);
    expect((await request(app).get(url).set("Authorization", auth(name))
      .send({ unrelated: true })).status).toBe(403);
    expect((await request(app).post(`${url}/comments`).set("Authorization", auth(name))
      .send({ body: "Fixed PR watcher observation" })).status).toBe(201);
    expect((await request(app).patch(url).set("Authorization", auth(name))
      .send({ status: status === "todo" ? "in_progress" : "todo", comment: "escalation" })).status).toBe(403);
    expect((await request(app).get(`/api/issues/${targets.disk.issueId}`).set("Authorization", auth(name))).status).toBe(403);
    await db.update(issues).set({ assigneeAgentId: targets.disk.assigneeAgentId }).where(eq(issues.id, issueId));
    expect((await request(app).get(url).set("Authorization", auth(name))).status).toBe(403);
    await db.update(issues).set({ assigneeAgentId: scopes[name]!.assigneeAgentId }).where(eq(issues.id, issueId));
    expect((await request(app).patch(url).set("Authorization", auth(name))
      .send({ status, comment: "extra field", priority: "critical" })).status).toBe(403);
    const allowed = await request(app).patch(url).set("Authorization", auth(name))
      .send({ status, comment: "Fixed watcher wake" });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect((await request(app).patch(url).set("Authorization", auth(name))
      .send({ status, comment: "repeat" })).status).toBe(403);
  });

  it("does not embed ancestor content in the fixed issue read", async () => {
    const parentId = randomUUID();
    await db.insert(issues).values({
      id: parentId, companyId, issueNumber: 998, identifier: "HWT-998",
      title: "Private ancestor", description: "Private ancestor content", status: "backlog",
    });
    await db.update(issues).set({ parentId }).where(eq(issues.id, targets.pr923.issueId));
    try {
      const result = await request(app).get(`/api/issues/${targets.pr923.issueId}`)
        .set("Authorization", auth("pr923"));
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ id: targets.pr923.issueId });
      expect(result.body).not.toHaveProperty("ancestors");
      expect(result.body).not.toHaveProperty("relatedWork");
      expect(JSON.stringify(result.body)).not.toContain("Private ancestor content");
    } finally {
      await db.update(issues).set({ parentId: null }).where(eq(issues.id, targets.pr923.issueId));
      await db.delete(issues).where(eq(issues.id, parentId));
    }
  });

  it("fleet can comment on its parent and create one bounded work order", async () => {
    const parentUrl = `/api/issues/${targets.fleet.issueId}`;
    expect((await request(app).post(`${parentUrl}/comments`).set("Authorization", auth("fleet"))
      .send({ body: "Hourly findings: one stuck task" })).status).toBe(201);
    const path = `/api/companies/${companyId}/issues`;
    const body = {
      title: "[watch][hourly] 30.09 06:00Z: 1 finding", description: "Hourly findings: one stuck task",
      status: "todo", priority: "high", assigneeAgentId: targets.fleet.assigneeAgentId,
      parentId: targets.fleet.issueId,
    };
    expect((await request(app).post(path).set("Authorization", auth("fleet"))
      .send({ ...body, assigneeAgentId: targets.disk.assigneeAgentId })).status).toBe(403);
    expect((await request(app).post(path).set("Authorization", auth("fleet"))
      .send({ ...body, projectId: fleetProjectId })).status).toBe(403);
    expect((await request(app).post(path).set("Authorization", auth("fleet"))
      .send({ ...body, parentId: targets.disk.issueId })).status).toBe(403);
    expect((await request(app).post(`/api/companies/${randomUUID()}/issues`)
      .set("Authorization", auth("fleet")).send(body)).status).toBe(403);
    const concurrent = await Promise.all([
      request(app).post(path).set("Authorization", auth("fleet")).send(body),
      request(app).post(path).set("Authorization", auth("fleet")).send(body),
    ]);
    const created = concurrent.find((response) => response.status === 201)!;
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(concurrent.filter((response) => response.status === 201)).toHaveLength(1);
    expect(concurrent.some((response) => response.status === 403 || response.status === 409)).toBe(true);
    const [order] = await db.select().from(issues).where(eq(issues.id, created.body.id as string));
    expect(order).toMatchObject({
      originKind: "host_watcher", originId: serviceAgents.fleet, parentId: targets.fleet.issueId,
      projectId: fleetProjectId, assigneeAgentId: targets.fleet.assigneeAgentId,
    });
    expect((await request(app).post(path).set("Authorization", auth("fleet")).send(body)).status).toBe(403);
    await expect(db.insert(issues).values({
      companyId, issueNumber: 999, identifier: "HWT-999", title: "Concurrent duplicate",
      status: "todo", originKind: "host_watcher", originId: serviceAgents.fleet!,
      parentId: targets.fleet.issueId, projectId: fleetProjectId,
      assigneeAgentId: targets.fleet.assigneeAgentId,
    })).rejects.toThrow();
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, order!.id));
    const replacement = await request(app).post(path).set("Authorization", auth("fleet"))
      .send({ ...body, title: "[watch][hourly] replacement after board hide" });
    expect(replacement.status, JSON.stringify(replacement.body)).toBe(201);
    expect((await request(app).patch(parentUrl).set("Authorization", auth("fleet"))
      .send({ status: "done" })).status).toBe(403);
  });

  it("fails closed on an invalid stored scope and keeps one active key per service identity", async () => {
    const diskAgentId = serviceAgents.disk!;
    await expect(agentService(db).createApiKey(diskAgentId, "second host key", scopes.disk!, {
      responsibleUserId,
    })).rejects.toThrow("exactly one active API key");
    await expect(agentService(db).createApiKey(diskAgentId, "broad key", { kind: "standard" }, {
      responsibleUserId,
    })).rejects.toThrow("exactly one active API key");
    await expect(agentService(db).createApiKey(serviceAgents.watchdog!, "broad cron companion", { kind: "standard" }, {
      responsibleUserId,
    })).rejects.toThrow("exactly one active API key");
    await expect(agentService(db).createApiKey(serviceAgents.quota!, "second cron key", cronScopes.quota!, {
      responsibleUserId,
    })).rejects.toThrow("exactly one active API key");
    await expect(db.insert(agentApiKeys).values({
      companyId, agentId: diskAgentId, name: "concurrent key",
      keyHash: createHash("sha256").update("second-test-only-key").digest("hex"),
      responsibleUserId, scopeConfig: scopes.disk!,
    })).rejects.toThrow();
    const [diskKey] = await db.select({ id: agentApiKeys.id }).from(agentApiKeys)
      .where(eq(agentApiKeys.agentId, diskAgentId));
    await db.update(agentApiKeys).set({ scopeConfig: { kind: "future_scope" } as never })
      .where(eq(agentApiKeys.id, diskKey!.id));
    try {
      expect((await request(app).patch(`/api/issues/${targets.disk.issueId}`)
        .set("Authorization", auth("disk"))
        .send({ status: "todo", comment: "invalid scope" })).status).toBe(403);
    } finally {
      await db.update(agentApiKeys).set({ scopeConfig: scopes.disk! }).where(eq(agentApiKeys.id, diskKey!.id));
    }
  });

  it("rechecks a watcher update under the issue row lock", async () => {
    const target = targets.pr923;
    try {
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, target.issueId));
      await expect(issueService(db).update(target.issueId, {
        status: "todo", companyGuard: companyId, hostWatcherScope: scopes.pr923!,
      })).rejects.toThrow("Host watcher target changed before the issue update");
      await db.update(issues).set({ status: "blocked", assigneeAgentId: targets.disk.assigneeAgentId })
        .where(eq(issues.id, target.issueId));
      await expect(issueService(db).update(target.issueId, {
        status: "todo", companyGuard: companyId, hostWatcherScope: scopes.pr923!,
      })).rejects.toThrow("Host watcher target changed before the issue update");
    } finally {
      await db.update(issues).set({ status: "blocked", assigneeAgentId: target.assigneeAgentId })
        .where(eq(issues.id, target.issueId));
    }
  });

  it("keeps run-scoped JWTs working without inheriting host watcher authority", async () => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: serviceAgents.pr923!, status: "running", contextSnapshot: {},
      responsibleUserId,
    });
    const ordinary = createLocalAgentJwt(serviceAgents.pr923!, companyId, "process", runId, responsibleUserId);
    expect(ordinary).toBeTruthy();
    expect((await request(app).get(`/api/issues/${targets.pr923.issueId}`)
      .set("Authorization", `Bearer ${ordinary}`)).status).toBe(200);
    const forgedScope = createLocalAgentJwt(serviceAgents.pr923!, companyId, "process", runId,
      responsibleUserId, scopes.pr923);
    expect(forgedScope).toBeTruthy();
    expect((await request(app).patch(`/api/issues/${targets.pr923.issueId}`)
      .set("Authorization", `Bearer ${forgedScope}`)
      .send({ status: "todo", comment: "JWT cannot use host scope" })).status).toBe(403);

    const cronRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: cronRunId, companyId, agentId: serviceAgents.watchdog!, status: "running", contextSnapshot: {},
      responsibleUserId,
    });
    const ordinaryCron = createLocalAgentJwt(serviceAgents.watchdog!, companyId,
      "process", cronRunId, responsibleUserId);
    expect(ordinaryCron).toBeTruthy();
    expect((await request(app).get(`/api/issues/${watchdogAlarmIssueId}`)
      .set("Authorization", `Bearer ${ordinaryCron}`)).status).toBe(200);
    const forgedCronScope = createLocalAgentJwt(serviceAgents.watchdog!, companyId,
      "process", cronRunId, responsibleUserId, cronScopes.watchdog);
    expect(forgedCronScope).toBeTruthy();
    expect((await request(app).post(`/api/issues/${watchdogAlarmIssueId}/comments`)
      .set("Authorization", `Bearer ${forgedCronScope}`)
      .send({ body: "JWT cannot use cron scope" })).status).toBe(403);
  });

  async function seedCommentsToOneBelowLimit(name: string, issueId: string) {
    const existing = await db.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId),
      eq(issueComments.issueId, issueId),
      eq(issueComments.authorAgentId, serviceAgents[name]!),
    ));
    const needed = HOST_WATCHER_COMMENT_LIMIT_PER_HOUR - 1 - existing.length;
    expect(needed).toBeGreaterThanOrEqual(0);
    if (needed > 0) await db.insert(issueComments).values(Array.from({ length: needed }, (_, index) => ({
      companyId, issueId, authorAgentId: serviceAgents[name]!,
      authorType: "agent" as const, body: `Prior watcher observation ${index}`,
    })));
  }

  it("atomically caps repeated and concurrent comment requests from one service key", async () => {
    const issueId = targets.pr923.issueId;
    await seedCommentsToOneBelowLimit("pr923", issueId);
    const url = `/api/issues/${issueId}/comments`;
    const responses = await Promise.all([
      request(app).post(url).set("Authorization", auth("pr923")).send({ body: "Concurrent watcher A" }),
      request(app).post(url).set("Authorization", auth("pr923")).send({ body: "Concurrent watcher B" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
    expect((await request(app).post(url).set("Authorization", auth("pr923"))
      .send({ body: "Repeated watcher message" })).status).toBe(429);
    const persisted = await db.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId),
      eq(issueComments.issueId, issueId),
      eq(issueComments.authorAgentId, serviceAgents.pr923!),
    ));
    expect(persisted).toHaveLength(HOST_WATCHER_COMMENT_LIMIT_PER_HOUR);
    await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, persisted[0]!.id));
    expect((await request(app).post(url).set("Authorization", auth("pr923"))
      .send({ body: "Deleted comment cannot reset quota" })).status).toBe(429);
  });

  it("does not turn a fleet watcher comment into a review decision and still enforces its quota", async () => {
    const issueId = targets.fleet.issueId;
    const stageId = randomUUID();
    const reviewState = {
      status: "pending",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: serviceAgents.fleet! },
      returnAssignee: { type: "agent", agentId: targets.fleet.assigneeAgentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    } as const;
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: serviceAgents.fleet!,
      executionPolicy: { stages: [{ id: stageId, type: "review", participants: [reviewState.currentParticipant] }] },
      executionState: reviewState,
    }).where(eq(issues.id, issueId));
    try {
      const url = `/api/issues/${issueId}/comments`;
      const reviewLike = await request(app).post(url).set("Authorization", auth("fleet"))
        .send({ body: "## Review: APPROVED" });
      expect(reviewLike.status, JSON.stringify(reviewLike.body)).toBe(201);
      const [afterComment] = await db.select({ status: issues.status, executionState: issues.executionState })
        .from(issues).where(eq(issues.id, issueId));
      expect(afterComment?.status).toBe("in_review");
      expect(afterComment?.executionState).toMatchObject({
        status: "pending", currentStageId: stageId, lastDecisionId: null,
      });
      expect(await db.select({ id: issueExecutionDecisions.id }).from(issueExecutionDecisions)
        .where(eq(issueExecutionDecisions.issueId, issueId))).toHaveLength(0);

      await seedCommentsToOneBelowLimit("fleet", issueId);
      expect((await request(app).post(url).set("Authorization", auth("fleet"))
        .send({ body: "Twelfth fleet observation" })).status).toBe(201);
      expect((await request(app).post(url).set("Authorization", auth("fleet"))
        .send({ body: "## Review: APPROVED\n\nThirteenth fleet observation" })).status).toBe(429);
      const [afterQuota] = await db.select({ status: issues.status, executionState: issues.executionState })
        .from(issues).where(eq(issues.id, issueId));
      expect(afterQuota?.status).toBe("in_review");
      expect(afterQuota?.executionState).toMatchObject({ lastDecisionId: null });
    } finally {
      await db.update(issues).set({
        status: "backlog", assigneeAgentId: null, executionPolicy: null, executionState: null,
      }).where(eq(issues.id, issueId));
    }
  });

  it("caps PATCH comments and rolls back the signal status when quota is exhausted", async () => {
    const issueId = targets.disk.issueId;
    await seedCommentsToOneBelowLimit("disk", issueId);
    const url = `/api/issues/${issueId}`;
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
    expect((await request(app).patch(url).set("Authorization", auth("disk"))
      .send({ status: "todo", comment: "Last permitted disk signal" })).status).toBe(200);
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
    expect((await request(app).patch(url).set("Authorization", auth("disk"))
      .send({ status: "todo", comment: "Disk signal over quota" })).status).toBe(429);
    const [signal] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(signal?.status).toBe("blocked");
  });

  it.skipIf(!process.env.PAPERCLIP_HOST_PACKAGE)("accepts the staged host Python transport with five distinct fixture keys", async () => {
    const hostPackage = process.env.PAPERCLIP_HOST_PACKAGE;
    if (!hostPackage) throw new Error("PAPERCLIP_HOST_PACKAGE must point to the staged board-watchers package");
    const temporarySources = await mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "hela13399-api-"));
    const tokenFile = join(temporarySources, "service.token");
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("host fixture has no port");
    const origin = `http://127.0.0.1:${address.port}`;
    const runPython = promisify(execFile);
    const program = `import json,sys,urllib.error
from service_http import request
try:
    request(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]))
    print(200)
except urllib.error.HTTPError as error:
    print(error.code)
`;
    async function call(method: string, path: string, body: unknown = null) {
      const { stdout } = await runPython("python3", ["-c", program, method, path, JSON.stringify(body)], {
        timeout: 15_000,
        env: { ...process.env, PYTHONPATH: hostPackage, PAPERCLIP_API_URL: origin, PAPERCLIP_TOKEN_FILE: tokenFile },
      });
      return Number(stdout.trim());
    }
    try {
      for (const [name, scope] of Object.entries(scopes)) {
        const serviceId = randomUUID();
        const token = `pc_host_transport_fixture_${name}`;
        await db.insert(agents).values({
          id: serviceId, companyId, name: `Transport ${name}`,
          adapterType: "process", adapterConfig: {}, runtimeConfig: {}, status: "idle",
        });
        await db.insert(agentApiKeys).values({
          agentId: serviceId, companyId, name: `transport ${name}`,
          keyHash: createHash("sha256").update(token).digest("hex"),
          responsibleUserId, scopeConfig: scope,
        });
        await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
        if (name === "disk") {
          await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, targets.disk.issueId));
          expect(await call("PATCH", `/api/issues/${targets.disk.issueId}`,
            { status: "todo", comment: "Host disk escalation fixture" })).toBe(200);
          expect(await call("POST", `/api/issues/${targets.disk.issueId}/comments`,
            { body: "Routine note is local only" })).toBe(403);
        } else if (name === "fleet") {
          await db.update(issues).set({ status: "backlog", assigneeAgentId: null })
            .where(eq(issues.id, targets.fleet.issueId));
          expect(await call("POST", `/api/issues/${targets.fleet.issueId}/comments`,
            { body: "Host fleet observation fixture" })).toBe(200);
          expect(await call("GET", `/api/issues/${targets.fleet.issueId}`)).toBe(403);
        } else {
          const target = name === "pr923" ? targets.pr923 : name === "be1198" ? targets.be1198 : targets.fe1042;
          const resume = name === "pr923" ? "todo" : "in_progress";
          await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, target.issueId));
          expect(await call("GET", `/api/issues/${target.issueId}`)).toBe(200);
          expect(await call("PATCH", `/api/issues/${target.issueId}`,
            { status: resume, comment: `Host ${name} wake fixture` })).toBe(200);
          expect(await call("GET", `/api/issues/${targets.disk.issueId}`)).toBe(403);
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(temporarySources, { recursive: true, force: true });
    }
  }, 90_000);
});
