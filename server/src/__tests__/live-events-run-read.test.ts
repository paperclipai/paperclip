import { readTaskPanelActivations } from "../services/plugin-task-panels.js";
import { plugins, heartbeatRunEvents } from "@paperclipai/db";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { redactEventPayload } from "../redaction.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import { redactActivityDetails } from "../services/activity-log.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentApiKeys, agents, authUsers, companies, companyMemberships, createDb,
  heartbeatRuns, issueAccessGrants, issueComments, issues, type Db,
} from "@paperclipai/db";
import * as schema from "@paperclipai/db/schema/index";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { publishLiveEvent } from "../services/live-events.js";
import { authorizationService, type AuthorizationActor } from "../services/authorization.js";
import { getHeartbeatRunReadDecisions } from "../services/heartbeat-run-privacy.js";
import { startRecoveryPostgres } from "./helpers/recovery-postgres.js";

describe("live-event run read boundaries", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: Db;
  const previousPrivacy = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  const previousMasterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("live-event-run-reads-");
    db = createDb(temporary.connectionString);
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = randomBytes(32).toString("base64");
  }, 120_000);

  afterAll(async () => {
    if (previousPrivacy === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacy;
    if (previousMasterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousMasterKey;
    await temporary?.cleanup();
  });

  it.each(["ready", "disabled", "error", "upgrade_pending"] as const)("restores a structured activation for an installed %s plugin", async status => {
    const companyId = randomUUID(), pluginKey = `example.recovered-${status}`;
    await db.insert(companies).values({ id: companyId, name: "Panel recovery", issuePrefix: `PNL${status.toUpperCase()}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Panel fixture", adapterType: "process" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "running" }).returning();
    await db.insert(plugins).values({ pluginKey, packageName: pluginKey, version: "1.0.0", status,
      manifestJson: { ui: { slots: [{ type: "detailTab", id: "screen", entityTypes: ["agent"], taskSidePanel: { availabilityPath: "/agents/:entityId/ready", activation: { namespace: `example.runtime-${status}`, activityKey: "desktop.used" } } }] } } as never });
    const write = (seq: number, panel: unknown) => db.insert(heartbeatRunEvents).values({ companyId, agentId: agent.id, runId: run.id,
      seq, eventType: "runtime.activity.recorded", payload: { prpEvent: { sourceKind: "runner", eventType: "runtime.activity.recorded", payload: panel } } });
    await write(1, { namespace: `example.runtime-${status}`, activityKey: "desktop.used" });
    await write(2, { namespace: `example.runtime-${status}`, activityKey: "unknown.activity" });
    await write(3, { namespace: "unknown.runtime", activityKey: "desktop.used" });
    await write(4, { namespace: `example.runtime-${status}`, activityKey: "desktop.used" }); // Replay may repeat activity with a new source ID.
    await write(5, { namespace: `example.runtime-${status}`, activityKey: "desktop.used", runId: "caller-run" });
    await db.insert(heartbeatRunEvents).values({ companyId, agentId: agent.id, runId: run.id, seq: 6,
      eventType: "runtime.activity.recorded", payload: { prpEvent: { sourceKind: "control_plane", eventType: "runtime.activity.recorded", payload: { namespace: `example.runtime-${status}`, activityKey: "desktop.used" } } } });
    expect(await readTaskPanelActivations(db, companyId, run.id)).toEqual([{ pluginKey, slotId: "screen" }]);
    expect(await readTaskPanelActivations(db, randomUUID(), run.id)).toEqual([]);
    await db.update(plugins).set({ status: "uninstalled" }).where(eq(plugins.pluginKey, pluginKey));
    expect(await readTaskPanelActivations(db, companyId, run.id)).toEqual([]);
  });

  it("reads only run bindings and reauthorizes every delivery after revocation or deletion", async () => {
    const companyId = randomUUID(), foreignCompanyId = randomUUID();
    const owner = randomUUID(), viewer = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Run reads", issuePrefix: "RUNREAD" },
      { id: foreignCompanyId, name: "Other company", issuePrefix: "OTHERREAD" },
    ]);
    await db.insert(authUsers).values([owner, viewer].map(id => ({
      id, name: "Fixture viewer", email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date(),
    })));
    await db.insert(companyMemberships).values([owner, viewer].map(principalId => ({
      companyId, principalType: "user", principalId, membershipRole: "operator", status: "active",
    })));
    const [agent] = await db.insert(agents).values({ companyId, name: "Fixture agent", adapterType: "process" }).returning();
    const [foreignAgent] = await db.insert(agents).values({ companyId: foreignCompanyId, name: "Other agent", adapterType: "process" }).returning();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Private task", visibility: "private", privacyRootIssueId: issueId, responsibleUserId: owner });
    const [grant] = await db.insert(issueAccessGrants).values({ issueId, subjectType: "user", subjectId: viewer, source: "explicit" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent.id, scopeKind: "issue", issueId, status: "running",
      contextSnapshot: { issueId, prompt: "private-context-".repeat(65_536) },
      runnerProfileJson: { instructions: "private-profile-".repeat(65_536) },
      stdoutExcerpt: "private-output-".repeat(65_536),
    }).returning({ id: heartbeatRuns.id });
    const [maintenance] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, scopeKind: "company" }).returning({ id: heartbeatRuns.id });
    const [foreign] = await db.insert(heartbeatRuns).values({ companyId: foreignCompanyId, agentId: foreignAgent.id, scopeKind: "company" }).returning({ id: heartbeatRuns.id });
    const hiddenIssueId = randomUUID();
    await db.insert(issues).values({ id: hiddenIssueId, companyId, title: "Other private task", visibility: "private", privacyRootIssueId: hiddenIssueId, responsibleUserId: owner });
    const [hiddenRun] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, scopeKind: "issue", issueId: hiddenIssueId }).returning({ id: heartbeatRuns.id });
    const reads: string[] = [];
    const queries: string[] = [];
    let failNextRunRead = false;
    let failNextIssueRead = false;
    const observedDb = drizzle(db.$client, { schema, logger: { logQuery(query) {
      queries.push(query);
      if (query.startsWith("select ") && query.includes('from "issues"') && failNextIssueRead) {
        failNextIssueRead = false;
        throw new Error("fixture issue lookup unavailable");
      }
      if (query.startsWith("select ") && query.includes('from "heartbeat_runs"')) {
        reads.push(query);
        if (failNextRunRead) { failNextRunRead = false; throw new Error("fixture run lookup unavailable"); }
      }
    } } }) as Db;
    const server = createServer();
    const wss = setupLiveEventsWebSocketServer(server, observedDb, {
      deploymentMode: "authenticated",
      resolveCloudActor: async () => ({ userId: viewer, companyIds: [companyId] }),
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${companyId}/events/ws`);
    const messages: Array<{ type: string; payload: Record<string, unknown> }> = [];
    socket.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
    try {
      await once(socket, "open");
      let deliveries = 0;
      async function deliver(runId: string, payloadIssueId?: string) {
        deliveries += 1;
        const start = messages.length;
        const barrier = randomUUID();
        publishLiveEvent({ companyId, type: "heartbeat.run.status", payload: {
          runId, status: "running", ...(payloadIssueId ? { issueId: payloadIssueId } : {}),
        } });
        publishLiveEvent({ companyId, type: "agent.status", payload: { agentId: barrier, status: "idle" } });
        await expect.poll(() => messages.some(message => message.payload.agentId === barrier)).toBe(true);
        return messages.slice(start).filter(message => message.type === "heartbeat.run.status");
      }

      expect(await deliver(run.id)).toMatchObject([{ payload: { runId: run.id, status: "running" } }]);
      const batchStart = queries.length;
      expect(await deliver(run.id, issueId)).toMatchObject([{ payload: { runId: run.id, issueId, status: "running" } }]);
      expect(queries.length - batchStart).toBeLessThanOrEqual(6);
      expect(queries.slice(batchStart).filter(query => query.startsWith("select ") && query.includes('from "issues"')).length).toBeLessThanOrEqual(2);
      const [parent] = await db.insert(issues).values({ companyId, title: "Readable parent" }).returning();
      await db.update(issues).set({ parentId: parent.id }).where(eq(issues.id, issueId));
      expect(await deliver(run.id, issueId)).toMatchObject([{ payload: { recentSubtaskParentIds: [parent.id] } }]);
      await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, parent.id));
      expect(await deliver(run.id, issueId)).toMatchObject([{ payload: { recentSubtaskParentIds: [] } }]);
      await db.update(issues).set({ parentId: null }).where(eq(issues.id, issueId));
      expect(await deliver(hiddenRun.id, issueId)).toEqual([]);
      expect(await deliver(run.id, hiddenIssueId)).toEqual([]);
      expect(await deliver(run.id, randomUUID())).toEqual([]);
      failNextIssueRead = true;
      expect(await deliver(run.id, issueId)).toEqual([]);
      expect(await deliver(run.id, issueId)).toHaveLength(1);
      await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant.id));
      expect(await deliver(run.id, issueId)).toEqual([]);
      expect(await deliver(run.id)).toEqual([]);
      expect(await deliver(maintenance.id)).toHaveLength(1);
      expect(await deliver(foreign.id)).toEqual([]);
      expect(await deliver(randomUUID())).toEqual([]);
      failNextRunRead = true;
      expect(await deliver(maintenance.id)).toEqual([]);
      expect(await deliver(maintenance.id)).toHaveLength(1);
      await db.update(issueAccessGrants).set({ revokedAt: null }).where(eq(issueAccessGrants.id, grant.id));
      expect(await deliver(run.id)).toHaveLength(1);
      await db.delete(issues).where(eq(issues.id, issueId));
      expect(await deliver(run.id)).toEqual([]);

      expect(reads).toHaveLength(deliveries);
      for (const query of reads) {
        expect(query).toMatch(/^select "heartbeat_runs"\."company_id", "heartbeat_runs"\."scope_kind", "heartbeat_runs"\."issue_id", "issues"\."parent_id" from "heartbeat_runs"/);
        expect(query).not.toMatch(/context_snapshot|runner_profile_json|stdout_excerpt|result_json/);
      }
      expect(JSON.stringify(messages)).not.toMatch(/private-context|private-profile|private-output/);
    } finally {
      socket.terminate();
      await Promise.all([...wss.clients].map(client => {
        const closed = new Promise<void>(resolve => client.on("close", resolve));
        client.terminate();
        return closed;
      }));
      await new Promise<void>((resolve, reject) => {
        (wss as typeof wss & { close(callback: (error?: Error) => void): void })
          .close(error => error ? reject(error) : resolve());
      });
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("delivers a burst of output without one permission read per event, and still stops at a revocation", async () => {
    const companyId = randomUUID(), owner = randomUUID(), viewer = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Burst reads", issuePrefix: `BR${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values([owner, viewer].map(id => ({ id, name: "Fixture viewer", email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() })));
    await db.insert(companyMemberships).values([owner, viewer].map(principalId => ({ companyId, principalType: "user", principalId, membershipRole: "operator", status: "active" })));
    const [agent] = await db.insert(agents).values({ companyId, name: "Burst agent", adapterType: "process" }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Private task", visibility: "private", privacyRootIssueId: issueId, responsibleUserId: owner });
    const [grant] = await db.insert(issueAccessGrants).values({ issueId, subjectType: "user", subjectId: viewer, source: "explicit" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, scopeKind: "issue", issueId, status: "running" }).returning({ id: heartbeatRuns.id });
    const queries: string[] = [];
    const observedDb = drizzle(db.$client, { schema, logger: { logQuery(query) { queries.push(query); } } }) as Db;
    const server = createServer();
    const wss = setupLiveEventsWebSocketServer(server, observedDb, { deploymentMode: "authenticated",
      resolveCloudActor: async () => ({ userId: viewer, companyIds: [companyId] }) });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${companyId}/events/ws`);
    const messages: Array<{ type: string; payload: Record<string, unknown> }> = [];
    socket.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
    const burst = async (count: number) => {
      const start = messages.length, queryStart = queries.length, barrier = randomUUID();
      for (let seq = 1; seq <= count; seq++) {
        publishLiveEvent({ companyId, type: "heartbeat.run.log", payload: { runId: run.id, seq, chunk: `token-${seq}` } });
        publishLiveEvent({ companyId, type: "heartbeat.run.event", payload: { runId: run.id, seq,
          payload: { prpEvent: { eventType: "item.delta", payload: { text: `native-${seq}` } } } } });
      }
      publishLiveEvent({ companyId, type: "agent.status", payload: { agentId: barrier, status: "idle" } });
      await expect.poll(() => messages.some(message => message.payload.agentId === barrier), { timeout: 20_000 }).toBe(true);
      return { delivered: messages.slice(start).filter(message => message.type.startsWith("heartbeat.run.")), queries: queries.slice(queryStart) };
    };
    try {
      await once(socket, "open");
      const first = await burst(100);
      expect(first.delivered.filter(message => message.type === "heartbeat.run.log").map(message => message.payload.seq))
        .toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
      expect(first.delivered.filter(message => message.type === "heartbeat.run.event")).toHaveLength(100);
      expect(first.queries.length).toBeLessThanOrEqual(40);
      await db.update(issueAccessGrants).set({ revokedAt: new Date() }).where(eq(issueAccessGrants.id, grant.id));
      expect((await burst(20)).delivered).toEqual([]);
    } finally {
      socket.terminate();
      await Promise.all([...wss.clients].map(client => { const closed = new Promise<void>(resolve => client.on("close", resolve)); client.terminate(); return closed; }));
      await new Promise<void>((resolve, reject) => (wss as typeof wss & { close(callback: (error?: Error) => void): void }).close(error => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each([false, true])("keeps transcript permissions current for agent sockets (negotiated=%s)", async negotiated => {
    const companyId = randomUUID(), viewer = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Restricted live reads", issuePrefix: `RL${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: viewer, name: "Fixture operator", email: `${viewer}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: viewer, membershipRole: "operator", status: "active" });
    const restrictedPermissions = { trustPreset: "low_trust_review", authorizationPolicy: {
      trustPreset: "low_trust_review", trustBoundary: { mode: "low_trust_review", companyId, rootIssueId: issueId },
    } };
    const [agent] = await db.insert(agents).values({ companyId, name: "Restricted viewer", adapterType: "process", permissions: restrictedPermissions }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Allowed task", assigneeAgentId: agent.id, responsibleUserId: viewer });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, scopeKind: "issue", issueId, status: "running" }).returning();
    const token = randomBytes(32).toString("hex");
    await db.insert(agentApiKeys).values({ companyId, agentId: agent.id, name: "Unscoped fixture", responsibleUserId: viewer,
      keyHash: createHash("sha256").update(token).digest("hex") });
    const actor: AuthorizationActor = { type: "agent", agentId: agent.id, companyId, source: "agent_key", onBehalfOfUserId: viewer };
    const access = authorizationService(db);
    const transcriptAllowed = async () => (await access.decide({ actor, action: "company_scope:read", resource: { type: "company", companyId } })).allowed;
    expect(await getHeartbeatRunReadDecisions(db, access, actor, [run])).toEqual([true]);
    expect(await transcriptAllowed()).toBe(false);
    const server = createServer();
    const wss = setupLiveEventsWebSocketServer(server, db, { deploymentMode: "authenticated" });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${companyId}/events/ws`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const messages: Array<{ type: string; revision?: number; payload?: Record<string, unknown> }> = [];
    socket.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
    const batch = async () => {
      const start = messages.length, barrier = randomUUID();
      publishLiveEvent({ companyId, type: "heartbeat.run.event", payload: { runId: run.id, seq: 1,
        payload: { prpEvent: { eventType: "item.delta", payload: { text: "native-text-and-tool-detail" } } } } });
      publishLiveEvent({ companyId, type: "heartbeat.run.log", payload: { runId: run.id, chunk: "legacy-log-content" } });
      publishLiveEvent({ companyId, type: "heartbeat.run.status", payload: { runId: run.id, status: "running" } });
      publishLiveEvent({ companyId, type: "agent.status", payload: { agentId: barrier, status: "idle" } });
      await expect.poll(() => messages.some(message => message.payload?.agentId === barrier)).toBe(true);
      return messages.slice(start);
    };
    try {
      await once(socket, "open");
      if (negotiated) {
        socket.send(JSON.stringify({ type: "live.interests", version: 1, revision: 1, runIds: [run.id] }));
        await expect.poll(() => messages.some(message => message.type === "live.subscribed")).toBe(true);
      }
      const denied = await batch();
      expect(denied.some(message => message.type === "heartbeat.run.status")).toBe(true);
      expect(denied.filter(message => ["heartbeat.run.event", "heartbeat.run.log"].includes(message.type))).toEqual([]);
      await db.update(agents).set({ permissions: {} }).where(eq(agents.id, agent.id));
      expect(await transcriptAllowed()).toBe(true);
      expect((await batch()).filter(message => ["heartbeat.run.event", "heartbeat.run.log"].includes(message.type))).toHaveLength(2);
      await db.update(agents).set({ permissions: restrictedPermissions }).where(eq(agents.id, agent.id));
      expect(await transcriptAllowed()).toBe(false);
      expect((await batch()).filter(message => ["heartbeat.run.event", "heartbeat.run.log"].includes(message.type))).toEqual([]);
    } finally {
      socket.terminate();
      await Promise.all([...wss.clients].map(client => { const closed = new Promise<void>(resolve => client.on("close", resolve)); client.terminate(); return closed; }));
      await new Promise<void>((resolve, reject) => (wss as typeof wss & { close(callback: (error?: Error) => void): void }).close(error => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it.each(["authenticated", "local_trusted"] as const)("redacts full saved notification text before preview truncation (%s)", async deploymentMode => {
    const companyId = randomUUID(), viewer = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Notification redaction", issuePrefix: `NR${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: viewer, name: "Fixture viewer", email: `${viewer}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: viewer, membershipRole: "operator", status: "active" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Notification fixture", adapterType: "process" }).returning();
    const registered = "ordinary-notification-credential-value";
    await db.insert(issues).values({ id: issueId, companyId, title: `Review ${registered}` });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, scopeKind: "issue", issueId,
      contextSnapshot: { issueId }, status: "running" }).returning();
    const registry = createRunSecretRedactionRegistry(db);
    await registry.register(companyId, run.id, registered);
    const previousCensor = (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs;
    await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: true });
    let failRedaction = false;
    const observedDb = drizzle(db.$client, { schema, logger: { logQuery(query) {
      if (failRedaction && query.startsWith("select ") && query.includes("paperclipSecretRedactions")) throw new Error("fixture secret registry unavailable");
    } } }) as Db;
    const server = createServer();
    const wss = setupLiveEventsWebSocketServer(server, observedDb, { deploymentMode,
      resolveCloudActor: async () => ({ userId: viewer, companyIds: [companyId] }) });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${companyId}/events/ws`);
    const deliver = async (commentId: string, body: string) => {
      const message = once(socket, "message");
      publishLiveEvent({ companyId, type: "activity.logged", payload: { action: "issue.comment_added", entityType: "issue", entityId: issueId,
        actorType: "agent", actorId: agent.id, details: { commentId, bodySnippet: body.slice(0, 120), issueTitle: `Review ${registered}`,
          changes: { description: { from: registered, to: body } } } } });
      const [bytes] = await message;
      return JSON.parse(bytes.toString()).payload;
    };
    try {
      await once(socket, "open");
      for (const body of [`Review ${registered} now`, `${"x".repeat(110)} ${registered} now`, `${homedir()}/notify.txt Authorization: Bearer header-fixture-value`]) {
        const [comment] = await db.insert(issueComments).values({ companyId, issueId, body, authorAgentId: agent.id }).returning();
        const payload = await deliver(comment.id, body);
        const expected = await redactActivityDetails(db, await registry.redactForIssue(companyId, issueId, { issueTitle: `Review ${registered}`, bodySnippet: body }));
        expect(payload.issueTitle).toBe(expected?.issueTitle);
        expect(payload.notificationDetails.bodySnippet).toBe(expected?.bodySnippet);
        expect(JSON.stringify(payload)).not.toContain(registered);
        expect(JSON.stringify(payload)).not.toContain(registered.slice(0, 9));
      }
      const titleWithPath = `${homedir()}/notify-task ${registered}`;
      await db.update(issues).set({ title: titleWithPath }).where(eq(issues.id, issueId));
      const deliverTitle = async (action: string) => {
        const message = once(socket, "message");
        publishLiveEvent({ companyId, type: "activity.logged", payload: { action, entityType: "issue", entityId: issueId,
          actorType: "system", details: { status: "blocked" } } });
        const [bytes] = await message;
        return JSON.parse(bytes.toString()).payload;
      };
      const maskedTitle = await redactActivityDetails(db, await registry.redactForIssue(companyId, issueId, { issueTitle: titleWithPath }));
      for (const action of ["issue.created", "issue.updated"]) {
        const payload = await deliverTitle(action);
        expect(payload.issueTitle).toBe(maskedTitle?.issueTitle);
        expect(JSON.stringify(payload)).not.toContain(homedir());
      }
      await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: false });
      const unmaskedTitle = await registry.redactForIssue(companyId, issueId, { issueTitle: titleWithPath });
      expect((await deliverTitle("issue.updated")).issueTitle).toBe(unmaskedTitle.issueTitle);
      await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: true });
      const foreignIssueId = randomUUID();
      await db.insert(issues).values({ id: foreignIssueId, companyId, title: "Other task" });
      const [foreign] = await db.insert(issueComments).values({ companyId, issueId: foreignIssueId, body: registered }).returning();
      expect((await deliver(foreign.id, registered)).notificationDetails).not.toHaveProperty("bodySnippet");
      const [deleted] = await db.insert(issueComments).values({ companyId, issueId, body: registered, deletedAt: new Date() }).returning();
      expect((await deliver(deleted.id, registered)).notificationDetails).not.toHaveProperty("bodySnippet");
      const [comment] = await db.insert(issueComments).values({ companyId, issueId, body: registered }).returning();
      failRedaction = true;
      const refused = await deliver(comment.id, registered);
      expect(refused.issueTitle).toBeNull();
      expect(refused.notificationDetails).not.toHaveProperty("bodySnippet");
      expect(JSON.stringify(refused)).not.toContain(registered);
    } finally {
      await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: previousCensor });
      socket.terminate();
      wss.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("shares notification redaction across viewers and refreshes secrets for each new event", async () => {
    const companyId = randomUUID(), viewer = randomUUID(), issueId = randomUUID(), otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Notification fanout", issuePrefix: `NF${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: viewer, name: "Fixture viewer", email: `${viewer}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: viewer, membershipRole: "operator", status: "active" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Fanout fixture", adapterType: "process" }).returning();
    const registered = "fanout-registered-fixture-value";
    await db.insert(issues).values([{ id: issueId, companyId, title: `Review ${registered}`, createdByUserId: viewer }, { id: otherIssueId, companyId, title: "Unrelated history" }]);
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, scopeKind: "issue", issueId, contextSnapshot: { issueId } }).returning();
    await db.insert(heartbeatRuns).values(Array.from({ length: 512 }, () => ({ companyId, agentId: agent.id, scopeKind: "issue" as const,
      issueId: otherIssueId, contextSnapshot: { issueId: otherIssueId } })));
    const registry = createRunSecretRedactionRegistry(db);
    await registry.register(companyId, run.id, registered);
    const registryQueries: Array<{ query: string; params: unknown[] }> = [];
    const observedDb = drizzle(db.$client, { schema, logger: { logQuery(query, params) {
      if (query.startsWith("select ") && query.includes("paperclipSecretRedactions")) registryQueries.push({ query, params });
    } } }) as Db;
    const resolve = vi.spyOn(getSecretProvider("local_encrypted"), "resolveVersion");
    const server = createServer();
    const wss = setupLiveEventsWebSocketServer(server, observedDb, { deploymentMode: "authenticated",
      resolveCloudActor: async () => ({ userId: viewer, companyIds: [companyId] }) });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${companyId}/events/ws`;
    const sockets = Array.from({ length: 6 }, () => new WebSocket(url));
    const deliver = async () => {
      const messages = Promise.all(sockets.map(socket => once(socket, "message")));
      publishLiveEvent({ companyId, type: "activity.logged", payload: { action: "issue.updated", entityType: "issue", entityId: issueId,
        actorType: "system", details: { status: "done" } } });
      return (await messages).map(([bytes]) => JSON.parse(bytes.toString()));
    };
    try {
      await Promise.all(sockets.map(socket => once(socket, "open")));
      for (let event = 0; event < 3; event += 1) {
        for (const message of await deliver()) expect(message.payload.issueTitle).toBe("Review ***REDACTED***");
      }
      expect(registryQueries).toHaveLength(6);
      expect(resolve).toHaveBeenCalledTimes(3);
      const nextSecret = "newly-registered-fanout-value";
      await registry.register(companyId, run.id, nextSecret);
      await db.update(issues).set({ title: `Review ${nextSecret}` }).where(eq(issues.id, issueId));
      for (const message of await deliver()) expect(message.payload.issueTitle).toBe("Review ***REDACTED***");
      expect(registryQueries).toHaveLength(8);
      expect(resolve).toHaveBeenCalledTimes(5);
    } finally {
      resolve.mockRestore();
      sockets.forEach(socket => socket.terminate());
      wss.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("bounds notification history reads with existing indexes and hides text on budget overflow", async () => {
    const companyId = randomUUID(), viewer = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Bounded notification", issuePrefix: `NB${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: viewer, name: "Fixture viewer", email: `${viewer}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: viewer, membershipRole: "operator", status: "active" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Budget fixture", adapterType: "process" }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Bounded title", createdByUserId: viewer });
    await db.insert(heartbeatRuns).values(Array.from({ length: 512 }, () => ({ companyId, agentId: agent.id, scopeKind: "issue" as const,
      issueId, contextSnapshot: { paperclipIssue: { id: issueId } } })));
    const unrelatedIssueId = randomUUID();
    await db.insert(issues).values({ id: unrelatedIssueId, companyId, title: "Other task history" });
    await db.insert(heartbeatRuns).values(Array.from({ length: 1024 }, () => ({ companyId, agentId: agent.id, scopeKind: "issue" as const,
      issueId: unrelatedIssueId, contextSnapshot: { paperclipIssue: { id: unrelatedIssueId } } })));
    const registryQueries: Array<{ query: string; params: unknown[] }> = [];
    const observedDb = drizzle(db.$client, { schema, logger: { logQuery(query, params) {
      if (query.startsWith("select ") && query.includes("paperclipSecretRedactions")) registryQueries.push({ query, params });
    } } }) as Db;
    const resolve = vi.spyOn(getSecretProvider("local_encrypted"), "resolveVersion");
    const server = createServer();
    const wss = setupLiveEventsWebSocketServer(server, observedDb, { deploymentMode: "authenticated",
      resolveCloudActor: async () => ({ userId: viewer, companyIds: [companyId] }) });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${companyId}/events/ws`);
    try {
      await once(socket, "open");
      const received = once(socket, "message");
      publishLiveEvent({ companyId, type: "activity.logged", payload: { action: "issue.updated", entityType: "issue", entityId: issueId,
        actorType: "system", details: { status: "blocked" } } });
      const [bytes] = await received;
      const event = JSON.parse(bytes.toString());
      expect(event.payload.issueTitle).toBeNull();
      expect(event.payload.notificationDetails).toEqual({ status: "blocked" });
      expect(registryQueries).toHaveLength(2);
      expect(resolve).not.toHaveBeenCalled();
      await db.$client.unsafe('ANALYZE heartbeat_runs');
      for (const statement of registryQueries) {
        expect(statement.query).toMatch(/order by .*created_at.*desc(?: nulls last)? limit/);
        const rows = await db.$client.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.query}`, statement.params as never[]);
        const plan = JSON.stringify(rows[0]["QUERY PLAN"]);
        expect(plan).toMatch(/heartbeat_runs_company_ctx_(?:issue|paperclip_issue)_created_idx/);
        type Plan = { "Actual Rows": number; "Rows Removed by Filter"?: number; Plans?: Plan[] };
        const bounded = (node: Plan) => {
          expect(node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)).toBeLessThanOrEqual(129);
          node.Plans?.forEach(bounded);
        };
        bounded((rows[0]["QUERY PLAN"] as Array<{ Plan: Plan }>)[0].Plan);
      }
      const oversizedIssue = randomUUID();
      const oversizedSecret = "oversized-notification-fixture".repeat(1000);
      await db.insert(issues).values({ id: oversizedIssue, companyId, title: oversizedSecret });
      const [oversizedRun] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, issueId: oversizedIssue,
        scopeKind: "issue", contextSnapshot: { issueId: oversizedIssue } }).returning();
      await createRunSecretRedactionRegistry(db).register(companyId, oversizedRun.id, oversizedSecret);
      const oversizedMessage = once(socket, "message");
      publishLiveEvent({ companyId, type: "activity.logged", payload: { action: "issue.updated", entityType: "issue", entityId: oversizedIssue,
        actorType: "system", details: { status: "blocked" } } });
      const [oversizedBytes] = await oversizedMessage;
      expect(JSON.parse(oversizedBytes.toString()).payload.issueTitle).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore();
      socket.terminate();
      wss.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each([["authenticated", "native"], ["local_trusted", "native"], ["authenticated", "panel"], ["local_trusted", "panel"]] as const)("redacts %s live rows like history reads for %s events", async (deploymentMode, kind) => {
    const companyId = randomUUID(), viewer = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Live redaction", issuePrefix: `LR${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: viewer, name: "Fixture viewer", email: `${viewer}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: viewer, membershipRole: "operator", status: "active" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Redaction fixture", adapterType: "process" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, scopeKind: "company", status: "running" }).returning();
    const registered = "registered-live-sentinel-value";
    const registry = createRunSecretRedactionRegistry(db);
    await registry.register(companyId, run.id, registered);
    await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: true });
    const body = kind === "panel" ? { prpEvent: { eventType: "runtime.activity.recorded", sourceKind: "runner", payload: { namespace: `example.${registered}`, activityKey: `${homedir()}/synthetic.txt` } } }
      : { prpEvent: { eventType: "item.delta", payload: { kind: "agentMessage",
        text: `${homedir()}/synthetic.txt ${registered}`, password: "sensitive-key-sentinel" } } };
    const sourcePayload = { runId: run.id, agentId: agent.id, seq: 1, eventType: kind === "panel" ? "runtime.activity.recorded" : "item.delta", payload: body };
    const expected = await registry.redactForRun(companyId, run.id,
      redactCurrentUserValue({ ...sourcePayload, payload: redactEventPayload(body) }, { enabled: true }));
    const queries: string[] = [];
    const observedDb = drizzle(db.$client, { schema, logger: { logQuery(query) { queries.push(query); } } }) as Db;
    const server = createServer();
    const wss = setupLiveEventsWebSocketServer(server, observedDb, { deploymentMode,
      resolveCloudActor: async () => ({ userId: viewer, companyIds: [companyId] }) });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/companies/${companyId}/events/ws`);
    const messages: Array<{ type: string; revision?: number; payload?: Record<string, unknown> }> = [];
    socket.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
    const barrier = async () => {
      const id = randomUUID();
      publishLiveEvent({ companyId, type: "agent.status", payload: { agentId: id, status: "idle" } });
      await expect.poll(() => messages.some(message => message.payload?.agentId === id)).toBe(true);
    };
    try {
      await once(socket, "open");
      socket.send(JSON.stringify({ type: "live.interests", version: 1, revision: 1, runIds: [] }));
      await expect.poll(() => messages.some(message => message.type === "live.subscribed" && message.revision === 1)).toBe(true);
      // Runtime-state refreshes reach the company without a transcript subscription.
      const refreshedAgentId = randomUUID();
      publishLiveEvent({ companyId, type: "agent.runtime_state.updated", payload: { agentId: refreshedAgentId } });
      await barrier();
      expect(messages.find(message => message.type === "agent.runtime_state.updated")?.payload).toMatchObject({ agentId: refreshedAgentId });
      const baseline = queries.length;
      publishLiveEvent({ companyId, type: "heartbeat.run.event", payload: sourcePayload }); await barrier();
      expect(messages.some(message => message.type === "heartbeat.run.event")).toBe(false);
      expect(queries.slice(baseline).some(query => query.includes("paperclipSecretRedactions") || query.includes('from "instance_settings"'))).toBe(false);
      socket.send(JSON.stringify({ type: "live.interests", version: 1, revision: 2, runIds: [run.id] }));
      await expect.poll(() => messages.some(message => message.type === "live.subscribed" && message.revision === 2)).toBe(true);
      publishLiveEvent({ companyId, type: "heartbeat.run.event", payload: sourcePayload }); await barrier();
      const delivered = messages.find(message => message.type === "heartbeat.run.event");
      expect(delivered?.payload).toEqual(expected);
      expect(JSON.stringify(delivered)).not.toContain(registered);
      expect(JSON.stringify(delivered)).not.toContain("sensitive-key-sentinel");
      expect(JSON.stringify(delivered)).not.toContain(homedir());
      expect(JSON.stringify(sourcePayload)).toContain(registered);
    } finally {
      socket.terminate();
      await Promise.all([...wss.clients].map(client => { const closed = new Promise<void>(resolve => client.on("close", resolve)); client.terminate(); return closed; }));
      await new Promise<void>((resolve, reject) => (wss as typeof wss & { close(callback: (error?: Error) => void): void }).close(error => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

});
