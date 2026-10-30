import { readTaskPanelActivations } from "../services/plugin-task-panels.js";
import { plugins, heartbeatRunEvents } from "@paperclipai/db";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { redactEventPayload } from "../redaction.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys, agents, authUsers, companies, companyMemberships, createDb,
  heartbeatRuns, issueAccessGrants, issues, type Db,
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
        expect(query).toMatch(/^select "company_id", "scope_kind", "issue_id" from "heartbeat_runs"/);
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
