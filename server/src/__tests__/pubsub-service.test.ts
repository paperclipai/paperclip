import { createHash, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, companies, createDb, heartbeatRuns, pubsubMessages, pubsubNonces, pubsubOutbox, pubsubSubscriptions, pubsubTrust, agentWakeupRequests, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { PUBSUB_DELIVERY_MAX_ATTEMPTS, PUBSUB_MAX_PENDING_INBOX_BYTES, PUBSUB_MAX_PENDING_WAKES, PUBSUB_PEER_MAX_RATE_MESSAGES, PUBSUB_WAKE_STALE_MS } from "@paperclipai/shared";
import { signPubsubEnvelope } from "../services/pubsub-crypto.js";
import { createPubsubWake } from "../services/pubsub-wake.js";
import { createPubsubService, type PubsubService } from "../services/pubsub.js";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/** Persistence is unreachable in these tests: the guards must fire before any db access. */
function throwDb(): Db {
  const boom = () => {
    throw new Error("PubSub persistence was reached before the topic guard");
  };
  return { select: boom, insert: boom, update: boom, delete: boom, transaction: boom } as unknown as Db;
}
describe("PubSub task-topic publication guard", () => {
  let guardIdentityDir: string;

  beforeAll(async () => {
    guardIdentityDir = await mkdtemp(path.join(tmpdir(), "paperclip-pubsub-guard-"));
    const local = generateKeyPairSync("ed25519");
    await writeFile(path.join(guardIdentityDir, "identity.json"), JSON.stringify({
      version: 1,
      instanceId: randomUUID(),
      privateKey: local.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }), { mode: 0o600 });
  });

  afterAll(async () => {
    await rm(guardIdentityDir, { recursive: true, force: true });
  });

  it.each([
    ["board", null],
    ["ceo", randomUUID()],
  ] as const)("rejects %s publication of fleet.task.completed with 403 before persistence", async (role, agentId) => {
    const service = createPubsubService(throwDb());
    await expect(service.publish({ companyId: randomUUID(), agentId, role, topic: "fleet.task.completed", payload: { ok: true } }))
      .rejects.toMatchObject({ status: 403, message: "Task topics are reserved for the activity journal" });
  });

  it("rejects receiving a board-signed task envelope with 403 before persistence", async () => {
    const service = createPubsubService(throwDb(), { identityPath: path.join(guardIdentityDir, "identity.json") });
    const local = await service.identity();
    const envelope = {
      version: 1, id: randomUUID(),
      from_instance: randomUUID(), from_company: randomUUID(), from_agent: null, from_role: "board",
      to_instance: local.instanceId, to_company: randomUUID(), to_topic: "fleet.task.completed",
      payload: { note: "forged task event" },
      timestamp: new Date().toISOString(), nonce: randomUUID(),
      signature: "x".repeat(86),
    };
    await expect(service.receive(envelope)).rejects.toMatchObject({
      status: 403, message: "Task events require a system sender",
    });
  });
});

describeEmbeddedPostgres("PubSub task-topic journal contract", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let db: Db;
  let service: PubsubService;
  let identityDir: string;
  let companyId: string;
  let ceoId: string;
  let peer: { instanceId: string; companyId: string; publicKey: string; privateKey: KeyObject };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pubsub-service-");
    db = createDb(tempDb.connectionString);
    identityDir = await mkdtemp(path.join(tmpdir(), "paperclip-pubsub-identity-"));
    const local = generateKeyPairSync("ed25519");
    const identityPath = path.join(identityDir, "identity.json");
    await writeFile(identityPath, JSON.stringify({
      version: 1,
      instanceId: randomUUID(),
      privateKey: local.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }), { mode: 0o600 });
    service = createPubsubService(db, { identityPath });

    companyId = randomUUID();
    ceoId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Task topic fixture", issuePrefix: "TT" });
    await db.insert(agents).values({ id: ceoId, companyId, name: "Runner CEO", role: "ceo", status: "active", adapterType: "paperclip_runner" });

    const peerKeys = generateKeyPairSync("ed25519");
    peer = {
      instanceId: randomUUID(),
      companyId: randomUUID(),
      publicKey: peerKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKey: peerKeys.privateKey,
    };
    await db.insert(pubsubTrust).values({
      companyId, peerInstanceId: peer.instanceId, peerCompanyId: peer.companyId,
      publicKey: peer.publicKey, url: "http://127.0.0.1:43100/api/pubsub/deliver",
      topics: ["fleet.task.*", "fleet.chat.*"], revokedAt: null,
    });
    await db.insert(pubsubSubscriptions).values({ companyId, peerInstanceId: peer.instanceId, topic: "fleet.task.completed" });
  }, 30_000);

  afterEach(async () => {
    await db.delete(pubsubMessages);
    await db.delete(activityLog);
  });

  afterAll(async () => {
    await rm(identityDir, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("rejects board and CEO publication of task topics with 403 and writes nothing", async () => {
    await expect(service.publish({ companyId, agentId: null, role: "board", topic: "fleet.task.completed", payload: { ok: true } }))
      .rejects.toMatchObject({ status: 403, message: "Task topics are reserved for the activity journal" });
    await expect(service.publish({ companyId, agentId: ceoId, role: "ceo", topic: "fleet.task.completed", payload: { ok: true } }))
      .rejects.toMatchObject({ status: 403, message: "Task topics are reserved for the activity journal" });
    const rows = await db.select({ id: pubsubMessages.id }).from(pubsubMessages).where(eq(pubsubMessages.companyId, companyId));
    expect(rows).toHaveLength(0);
  });

  it("accepts journal publication of a task topic and enqueues it for the granted peer", async () => {
    const eventId = randomUUID();
    const issueId = randomUUID();
    await db.insert(activityLog).values({
      id: eventId,
      companyId, actorType: "system", actorId: "native-status-committer",
      action: "issue.updated", entityType: "issue", entityId: issueId,
      details: { source: "native_status_decision", fromStatus: "in_progress", toStatus: "done" },
    });
    const result = await service.publishActivity(eventId, {
      companyId, agentId: null, role: "system", topic: "fleet.task.completed",
      payload: { eventId, issueId, details: { status: "done" } },
    });
    expect(result).toEqual({ id: expect.any(String), queued: 1 });
    const [message] = await db.select().from(pubsubMessages).where(and(eq(pubsubMessages.companyId, companyId), eq(pubsubMessages.direction, "outgoing")));
    expect(message.topic).toBe("fleet.task.completed");
    expect(message.fromRole).toBe("system");
  });

  it("dedupes a repeat activity publication by (eventId, topic) without a new outbox row", async () => {
    const eventId = randomUUID();
    const issueId = randomUUID();
    await db.insert(activityLog).values({
      id: eventId,
      companyId, actorType: "user", actorId: "board-user",
      action: "issue.updated", entityType: "issue", entityId: issueId,
      details: { changes: { status: { from: "in_progress", to: "done" } } },
    });
    const first = await service.publishActivity(eventId, {
      companyId, agentId: null, role: "system", topic: "fleet.task.review",
      payload: { eventId, issueId, status: "done", review: "required" },
    });
    expect(first.queued).toBe(1);
    const second = await service.publishActivity(eventId, {
      companyId, agentId: null, role: "system", topic: "fleet.task.review",
      payload: { eventId, issueId, status: "done", review: "required" },
    });
    expect(second).toEqual({ id: first.id, queued: 0 });
    const messages = await db.select({ id: pubsubMessages.id }).from(pubsubMessages).where(eq(pubsubMessages.companyId, companyId));
    expect(messages).toHaveLength(1);
    const outbox = await db.select({ id: pubsubOutbox.id }).from(pubsubOutbox).where(eq(pubsubOutbox.companyId, companyId));
    expect(outbox).toHaveLength(1);
  });

  async function signedTaskEnvelope(fromRole: "system" | "board" | "ceo", agentId: string | null) {
    const local = await service.identity();
    return signPubsubEnvelope({
      version: 1, id: randomUUID(),
      from_instance: peer.instanceId, from_company: peer.companyId,
      from_agent: agentId, from_role: fromRole,
      to_instance: local.instanceId, to_company: companyId,
      to_topic: "fleet.task.completed", payload: { note: "cross-company task event" },
      timestamp: new Date().toISOString(), nonce: randomUUID(),
    }, peer.privateKey);
  }

  it.each([
    ["board", null],
    ["ceo", randomUUID()],
  ] as const)("rejects receiving a %s-signed task envelope with 403", async (role, agentId) => {
    await expect(service.receive(await signedTaskEnvelope(role, agentId)))
      .rejects.toMatchObject({ status: 403, message: "Task events require a system sender" });
  });

  it("accepts a system-signed task envelope and exposes fromRole in inbox and history", async () => {
    const result = await service.receive(await signedTaskEnvelope("system", null));
    expect(result).toEqual({ id: expect.any(String), duplicate: false });
    const inbox = await service.inbox(companyId);
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].fromRole).toBe("system");
    expect(inbox.items[0].fromInstance).toBe(peer.instanceId);
    const history = await service.history(companyId, { topic: "fleet.task.completed" });
    expect(history.items).toHaveLength(1);
    expect(history.items[0].fromRole).toBe("system");
    expect(history.items[0].topic).toBe("fleet.task.completed");
  });

  it("reconciles a stale live wake receipt once its run has settled, and leaves in-flight runs alone", async () => {
    const wakeService = createPubsubService(db, { identityPath: path.join(identityDir, "identity.json"), wake: async () => {} });
    const settledRunId = randomUUID();
    const liveRunId = randomUUID();
    const settledFinishedAt = new Date(Date.now() - 5_000);
    await db.insert(heartbeatRuns).values({
      id: settledRunId, companyId, agentId: ceoId, status: "succeeded",
      wakeupRequestId: null, finishedAt: settledFinishedAt, error: null,
    });
    await db.insert(heartbeatRuns).values({
      id: liveRunId, companyId, agentId: ceoId, status: "running", startedAt: new Date(),
    });
    const staleKey = `pubsub:${companyId}:${peer.instanceId}:${peer.companyId}:${randomUUID()}`;
    const liveKey = `pubsub:${companyId}:${peer.instanceId}:${peer.companyId}:${randomUUID()}`;
    const [staleWake] = await db.insert(agentWakeupRequests).values({
      companyId, agentId: ceoId, source: "automation", status: "claimed", claimedAt: new Date(),
      runId: settledRunId, idempotencyKey: staleKey,
    }).returning();
    await db.update(heartbeatRuns).set({ wakeupRequestId: staleWake.id }).where(eq(heartbeatRuns.id, settledRunId));
    const [liveWake] = await db.insert(agentWakeupRequests).values({
      companyId, agentId: ceoId, source: "automation", status: "claimed", claimedAt: new Date(),
      runId: liveRunId, idempotencyKey: liveKey,
    }).returning();
    await db.update(heartbeatRuns).set({ wakeupRequestId: liveWake.id }).where(eq(heartbeatRuns.id, liveRunId));

    // The service owns its 200ms tick interval with no injection point, so the
    // test waits a short wall-clock span for a tick to run (fake timers would
    // deadlock the driver's internal timers against real Postgres I/O).
    const stop = await wakeService.start();
    try {
      await sleep(700);
      const settled = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, staleWake.id));
      expect(settled[0].status).toBe("completed");
      expect(settled[0].finishedAt?.toISOString()).toBe(settledFinishedAt.toISOString());
      const live = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, liveWake.id));
      expect(live[0].status).toBe("claimed");
      expect(live[0].finishedAt).toBeNull();
    } finally {
      await stop();
    }
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
  });
});

describeEmbeddedPostgres("PubSub ingress admission and nonce company scoping", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let db: Db;
  let service: PubsubService;
  let identityDir: string;
  let companyId: string;
  let secondCompanyId: string;
  let peer: { instanceId: string; companyId: string; agentId: string; privateKey: KeyObject };

  async function signedChatEnvelope(toCompanyId: string, options: { id?: string; nonce?: string; payload?: unknown } = {}) {
    const local = await service.identity();
    return signPubsubEnvelope({
      version: 1, id: options.id ?? randomUUID(),
      from_instance: peer.instanceId, from_company: peer.companyId, from_agent: peer.agentId, from_role: "ceo",
      to_instance: local.instanceId, to_company: toCompanyId, to_topic: "fleet.chat.ingress",
      payload: options.payload ?? { note: "admission fixture" },
      timestamp: new Date().toISOString(), nonce: options.nonce ?? randomUUID(),
    }, peer.privateKey);
  }

  async function seedIncomingRow(companyId: string, options: { payload?: unknown; wakePending?: number } = {}) {
    await db.insert(pubsubMessages).values({
      companyId, id: randomUUID(), direction: "incoming", topic: "fleet.chat.ingress",
      payload: options.payload ?? { seeded: true }, fromInstance: peer.instanceId, fromCompany: peer.companyId,
      fromAgent: peer.agentId, fromRole: "ceo", contentHash: "seeded", wakePending: options.wakePending ?? 0,
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pubsub-admission-");
    db = createDb(tempDb.connectionString);
    identityDir = await mkdtemp(path.join(tmpdir(), "paperclip-pubsub-admission-identity-"));
    const local = generateKeyPairSync("ed25519");
    const identityPath = path.join(identityDir, "identity.json");
    await writeFile(identityPath, JSON.stringify({
      version: 1,
      instanceId: randomUUID(),
      privateKey: local.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }), { mode: 0o600 });
    service = createPubsubService(db, { identityPath });

    companyId = randomUUID();
    secondCompanyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Admission fixture", issuePrefix: "AD" });
    await db.insert(companies).values({ id: secondCompanyId, name: "Admission fixture B", issuePrefix: "AD2" });
    const peerKeys = generateKeyPairSync("ed25519");
    peer = {
      instanceId: randomUUID(),
      companyId: randomUUID(),
      agentId: randomUUID(),
      privateKey: peerKeys.privateKey,
    };
    for (const trustedCompanyId of [companyId, secondCompanyId]) {
      await db.insert(pubsubTrust).values({
        companyId: trustedCompanyId, peerInstanceId: peer.instanceId, peerCompanyId: peer.companyId,
        publicKey: peerKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        url: "http://127.0.0.1:43100/api/pubsub/deliver",
        topics: ["fleet.chat.*"], revokedAt: null,
      });
      await db.insert(pubsubSubscriptions).values({ companyId: trustedCompanyId, peerInstanceId: peer.instanceId, topic: "fleet.chat.ingress" });
    }
  }, 30_000);

  afterEach(async () => {
    await db.delete(pubsubMessages);
    await db.delete(pubsubNonces);
    await db.delete(activityLog);
  });

  afterAll(async () => {
    await rm(identityDir, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("rejects a peer delivery with 429 once the company wake queue is full", async () => {
    for (let index = 0; index < PUBSUB_MAX_PENDING_WAKES; index++) {
      expect(await service.receive(await signedChatEnvelope(companyId))).toMatchObject({ duplicate: false });
    }
    await expect(service.receive(await signedChatEnvelope(companyId)))
      .rejects.toMatchObject({ status: 429, message: "PubSub wake queue is full; retry later" });
    const pending = await db.select({ id: pubsubMessages.id }).from(pubsubMessages).where(and(
      eq(pubsubMessages.companyId, companyId),
      eq(pubsubMessages.direction, "incoming"),
      eq(pubsubMessages.wakePending, 1),
    ));
    expect(pending).toHaveLength(PUBSUB_MAX_PENDING_WAKES);
  });

  it("rejects a peer delivery with 429 once the peer rate window is full", async () => {
    for (let index = 0; index < PUBSUB_PEER_MAX_RATE_MESSAGES; index++) await seedIncomingRow(companyId);
    await expect(service.receive(await signedChatEnvelope(companyId)))
      .rejects.toMatchObject({ status: 429, message: "PubSub peer rate limit exceeded; retry later" });
  });

  it("rejects a peer delivery with 429 once the pending inbox byte quota is full", async () => {
    await seedIncomingRow(companyId, { payload: { blob: "x".repeat(PUBSUB_MAX_PENDING_INBOX_BYTES) } });
    await expect(service.receive(await signedChatEnvelope(companyId)))
      .rejects.toMatchObject({ status: 429, message: "PubSub pending inbox is full; retry later" });
  });

  it("counts the incoming payload against the pending inbox byte quota", async () => {
    // Stored just under the byte limit: the old check (stored bytes only) admitted
    // this delivery and pushed the inbox over the bound with the stored payload.
    const storedBlob = PUBSUB_MAX_PENDING_INBOX_BYTES - JSON.stringify({ blob: "" }).length - 10;
    await seedIncomingRow(companyId, { payload: { blob: "x".repeat(storedBlob) } });
    await expect(service.receive(await signedChatEnvelope(companyId, { payload: { note: "incoming payload crosses the byte quota" } })))
      .rejects.toMatchObject({ status: 429, message: "PubSub pending inbox is full; retry later" });
  });

  it("resolves an idempotent retry as duplicate even when every admission quota is full", async () => {
    const first = await service.receive(await signedChatEnvelope(companyId));
    expect(first).toMatchObject({ duplicate: false });
    // Fill the wake queue, the peer rate window, and the pending-inbox byte quota.
    for (let index = 0; index < PUBSUB_MAX_PENDING_WAKES - 1; index++) {
      expect(await service.receive(await signedChatEnvelope(companyId))).toMatchObject({ duplicate: false });
    }
    for (let index = 0; index < PUBSUB_PEER_MAX_RATE_MESSAGES; index++) await seedIncomingRow(companyId);
    await seedIncomingRow(companyId, { payload: { blob: "x".repeat(PUBSUB_MAX_PENDING_INBOX_BYTES) } });
    // A fresh delivery now fails admission...
    await expect(service.receive(await signedChatEnvelope(companyId)))
      .rejects.toMatchObject({ status: 429 });
    // ...but the re-send of an already-stored delivery gets the promised
    // duplicate 200 instead of 429, and stores no second row.
    expect(await service.receive(await signedChatEnvelope(companyId, { id: first.id })))
      .toMatchObject({ id: first.id, duplicate: true });
    const rows = await db.select({ id: pubsubMessages.id }).from(pubsubMessages).where(eq(pubsubMessages.id, first.id));
    expect(rows).toHaveLength(1);
  });

  it("rejects a same-id resend with different content with 409 and keeps the stored row", async () => {
    const id = randomUUID();
    expect(await service.receive(await signedChatEnvelope(companyId, { id, payload: { note: "original content" } })))
      .toMatchObject({ id, duplicate: false });
    // Same stable id, fresh nonce, different content: a conflict, not a duplicate.
    await expect(service.receive(await signedChatEnvelope(companyId, { id, payload: { note: "conflicting content" } })))
      .rejects.toMatchObject({ status: 409, message: "PubSub message id conflicts with previously received content" });
    const [row] = await db.select().from(pubsubMessages).where(eq(pubsubMessages.id, id));
    expect(row.payload).toEqual({ note: "original content" });
    expect(row.contentHash).not.toEqual("seeded");
  });

  it("never sweeps an acked message whose CEO wake is still pending", async () => {
    const old = new Date(Date.now() - 31 * 24 * 3_600_000);
    const retained = await db.insert(pubsubMessages).values({
      companyId, id: randomUUID(), direction: "incoming", topic: "fleet.chat.ingress", payload: { kept: true },
      fromInstance: peer.instanceId, fromCompany: peer.companyId, fromAgent: peer.agentId, fromRole: "ceo",
      contentHash: "kept", wakePending: 1, ackedAt: old,
    }).returning();
    const swept = await db.insert(pubsubMessages).values({
      companyId, id: randomUUID(), direction: "incoming", topic: "fleet.chat.ingress", payload: { gone: true },
      fromInstance: peer.instanceId, fromCompany: peer.companyId, fromAgent: peer.agentId, fromRole: "ceo",
      contentHash: "gone", wakePending: 0, ackedAt: old,
    }).returning();
    // The service owns its 200ms tick interval with no injection point, so the
    // test waits a short wall-clock span for a tick to run (fake timers would
    // deadlock the driver's internal timers against real Postgres I/O).
    const stop = await service.start();
    try {
      await sleep(700);
      const remaining = await db.select({ id: pubsubMessages.id }).from(pubsubMessages).where(eq(pubsubMessages.companyId, companyId));
      expect(remaining.map((row) => row.id)).toEqual([retained[0].id]);
    } finally {
      await stop();
    }
  });

  it("scopes the replay nonce cache by company, not by peer alone", async () => {
    const nonce = randomUUID();
    expect(await service.receive(await signedChatEnvelope(companyId, { nonce }))).toMatchObject({ duplicate: false });
    // The same (peer, nonce) pair is fresh for a second trusting company.
    expect(await service.receive(await signedChatEnvelope(secondCompanyId, { nonce }))).toMatchObject({ duplicate: false });
    // And still replay-protected for the first company.
    await expect(service.receive(await signedChatEnvelope(companyId, { nonce: nonce, id: randomUUID() })))
      .rejects.toMatchObject({ status: 409, message: "PubSub nonce was already received" });
  });

  it("writes a durable activity entry for every accepted delivery", async () => {
    const envelope = await signedChatEnvelope(companyId);
    expect(await service.receive(envelope)).toMatchObject({ duplicate: false });
    const [entry] = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "pubsub.delivery_accepted"),
      eq(activityLog.entityId, envelope.id),
    ));
    expect(entry).toMatchObject({
      entityType: "pubsub",
      actorType: "system",
      actorId: peer.instanceId,
      details: null,
    });
    // An idempotent retry creates no rows, so it adds no entry either.
    expect(await service.receive(envelope)).toMatchObject({ duplicate: true });
    const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.entityId, envelope.id),
    ));
    expect(count.n).toBe(1);
  });
});

describeEmbeddedPostgres("PubSub wake guard run liveness", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let db: Db;
  let companyId: string;
  let ceoId: string;

  const inboundMessage = {
    id: randomUUID(),
    topic: "fleet.chat.ingress",
    payload: { note: "second wake" },
    fromInstance: randomUUID(),
    fromCompany: randomUUID(),
    fromAgent: null,
    fromRole: "board" as const,
    envelope: null,
  };

  /** A heartbeat that records wake calls and materializes the durable receipt the bridge checks for. */
  function recordingHeartbeat() {
    const calls: string[] = [];
    return {
      calls,
      heartbeat: {
        wakeup: async (agentId: string, options: Record<string, unknown>) => {
          calls.push(agentId);
          await db.insert(agentWakeupRequests).values({
            companyId, agentId, source: "automation", status: "queued",
            requestedAt: new Date(), idempotencyKey: options.idempotencyKey as string,
          });
        },
      },
    };
  }

  /**
   * Seed a live PubSub wake receipt plus its linked run, the receipt aged past
   * the stale window. Run liveness evidence is controlled by options: by
   * default none (activity clock aged, controller lease absent — a SIGKILL
   * orphan), with optional fresh provider output or an unexpired lease.
   */
  async function seedAgedLiveWake(
    runStatus: string,
    options: {
      runFinishedAt?: Date;
      receiptStatus?: string;
      receiptUpdatedAt?: Date;
      lastOutputAt?: Date | null;
      controllerLeaseExpiresAt?: Date | null;
    } = {},
  ) {
    const ageMs = PUBSUB_WAKE_STALE_MS + 600_000;
    const old = new Date(Date.now() - ageMs);
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId, agentId: ceoId, source: "automation", reason: "pubsub_message",
      status: options.receiptStatus ?? "running", claimedAt: old, requestedAt: old,
      updatedAt: options.receiptUpdatedAt ?? old, runId: null,
      idempotencyKey: `pubsub:${companyId}:${randomUUID()}:${randomUUID()}:${randomUUID()}`,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: ceoId, status: runStatus,
      startedAt: old, finishedAt: options.runFinishedAt ?? null,
      lastOutputAt: options.lastOutputAt ?? null,
      controllerLeaseExpiresAt: options.controllerLeaseExpiresAt ?? null,
      createdAt: old,
      wakeupRequestId: wake.id,
    }).returning();
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pubsub-wake-liveness-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    ceoId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Wake guard fixture", issuePrefix: "WG" });
    await db.insert(agents).values({ id: ceoId, companyId, name: "Local CEO", role: "ceo", status: "active", adapterType: "claude_local" });
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps a healthy long-running wake holding the company slot past the stale window", async () => {
    // The receipt is far older than the stale window, but its linked run is
    // still open and emitting fresh provider output — live liveness evidence,
    // so the slot must stay held and no second, non-coalesced wake may
    // enqueue even though recovery has not settled the run.
    await seedAgedLiveWake("running", { lastOutputAt: new Date(Date.now() - 10_000) });
    const { heartbeat, calls } = recordingHeartbeat();
    await expect(createPubsubWake(db, heartbeat)(companyId, inboundMessage))
      .rejects.toThrow("in flight");
    expect(calls).toHaveLength(0);
    const rows = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey,
        `pubsub:${companyId}:${inboundMessage.fromInstance}:${inboundMessage.fromCompany}:${inboundMessage.id}`));
    expect(rows).toHaveLength(0);
  });

  it("releases the company slot once a stale live wake's linked run has settled", async () => {
    // The receipt is older than the stale window and its run has settled, so
    // the slot is free even though the receipt itself has not been
    // reconciled to terminal state yet.
    await seedAgedLiveWake("succeeded", { runFinishedAt: new Date(Date.now() - (PUBSUB_WAKE_STALE_MS + 500_000)) });
    const { heartbeat, calls } = recordingHeartbeat();
    await createPubsubWake(db, heartbeat)(companyId, inboundMessage);
    expect(calls).toHaveLength(1);
  });

  it("releases the company slot for a stale claimed wake whose open run lost liveness (SIGKILL orphan)", async () => {
    // The defect: the wake owner was SIGKILL'd mid-flight. The receipt stays
    // `claimed` with no finished time and the linked run sits parked
    // non-terminal — recovery preserves ownership evidence indefinitely — so
    // it neither settles nor shows any liveness. Once the receipt itself ages
    // past the stale window the slot must be released again, or one stuck
    // receipt turns every inbound delivery into a 429 forever.
    await seedAgedLiveWake("running", { receiptStatus: "claimed" });
    const { heartbeat, calls } = recordingHeartbeat();
    await createPubsubWake(db, heartbeat)(companyId, inboundMessage);
    expect(calls).toHaveLength(1);
  });

  it("keeps a fresh live wake holding the company slot even without run evidence", async () => {
    // A wake claimed moments ago (inside the stale window) holds the slot
    // regardless of the run's evidence state: the guard is first an in-flight
    // and burst-dedup protection.
    await seedAgedLiveWake("running", {
      receiptStatus: "claimed",
      receiptUpdatedAt: new Date(Date.now() - 5_000),
      lastOutputAt: null,
    });
    const { heartbeat, calls } = recordingHeartbeat();
    await expect(createPubsubWake(db, heartbeat)(companyId, inboundMessage))
      .rejects.toThrow("in flight");
    expect(calls).toHaveLength(0);
  });

  it("holds the company slot through the cooldown for a recently settled terminal wake", async () => {
    // Terminal receipts keep the documented cooldown: its run already settled,
    // yet a second wake must still wait out the window.
    await db.insert(agentWakeupRequests).values({
      companyId, agentId: ceoId, source: "automation", reason: "pubsub_message",
      status: "completed", requestedAt: new Date(Date.now() - 30_000),
      updatedAt: new Date(), finishedAt: new Date(Date.now() - 10_000),
      idempotencyKey: `pubsub:${companyId}:${randomUUID()}:${randomUUID()}:${randomUUID()}`,
    });
    const { heartbeat, calls } = recordingHeartbeat();
    await expect(createPubsubWake(db, heartbeat)(companyId, inboundMessage))
      .rejects.toThrow("recently settled");
    expect(calls).toHaveLength(0);
  });
});

describeEmbeddedPostgres("PubSub wake orphan reconciliation", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let db: Db;
  let service: PubsubService;
  let identityDir: string;
  let companyId: string;
  let ceoId: string;

  async function seedPair(options: { receiptStatus: string; receiptAgeMs: number; runStatus: string; lastOutputAt: Date | null }) {
    const old = new Date(Date.now() - PUBSUB_WAKE_STALE_MS - 600_000);
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId, agentId: ceoId, source: "automation", reason: "pubsub_message",
      status: options.receiptStatus, claimedAt: old, requestedAt: old,
      updatedAt: new Date(Date.now() - options.receiptAgeMs), runId: null,
      idempotencyKey: `pubsub:${companyId}:${randomUUID()}:${randomUUID()}:${randomUUID()}`,
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: ceoId, status: options.runStatus,
      startedAt: old, lastOutputAt: options.lastOutputAt, createdAt: old,
      wakeupRequestId: wake.id,
    }).returning();
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
    return wake.id;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pubsub-orphan-");
    db = createDb(tempDb.connectionString);
    identityDir = await mkdtemp(path.join(tmpdir(), "paperclip-pubsub-orphan-identity-"));
    const local = generateKeyPairSync("ed25519");
    const identityPath = path.join(identityDir, "identity.json");
    await writeFile(identityPath, JSON.stringify({
      version: 1, instanceId: randomUUID(),
      privateKey: local.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }), { mode: 0o600 });
    service = createPubsubService(db, { identityPath, wake: async () => {} });
    companyId = randomUUID();
    ceoId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Orphan fixture", issuePrefix: "OR" });
    await db.insert(agents).values({ id: ceoId, companyId, name: "Orphan CEO", role: "ceo", status: "active", adapterType: "paperclip_runner" });
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
  });

  afterAll(async () => {
    await rm(identityDir, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("finalizes an orphaned wake receipt whose run lost every liveness signal", async () => {
    const wakeId = await seedPair({ receiptStatus: "claimed", receiptAgeMs: PUBSUB_WAKE_STALE_MS + 10_000, runStatus: "running", lastOutputAt: null });
    const stop = await service.start();
    try {
      await sleep(700);
    } finally {
      await stop();
    }
    const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    expect(row.status).toBe("failed");
    expect(row.error).toContain("lost liveness");
    // The finished stamp reuses the already-stale receipt touch, so
    // finalizing an orphan does not restart the guard cooldown for a wake
    // that never executed.
    expect(row.finishedAt!.getTime()).toBeLessThanOrEqual(Date.now() - PUBSUB_WAKE_STALE_MS);
  });

  it("leaves receipts untouched while their run is live or the wake is fresh", async () => {
    const healthy = await seedPair({ receiptStatus: "running", receiptAgeMs: PUBSUB_WAKE_STALE_MS + 10_000, runStatus: "running", lastOutputAt: new Date() });
    const fresh = await seedPair({ receiptStatus: "claimed", receiptAgeMs: 5_000, runStatus: "running", lastOutputAt: null });
    const stop = await service.start();
    try {
      await sleep(700);
    } finally {
      await stop();
    }
    const rows = await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status }).from(agentWakeupRequests);
    expect(rows.find((r) => r.id === healthy)!.status).toBe("running");
    expect(rows.find((r) => r.id === fresh)!.status).toBe("claimed");
  });
});

describeEmbeddedPostgres("PubSub egress delivery budget", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let db: Db;
  let service: PubsubService;
  let identityDir: string;
  let companyId: string;
  let offlinePeer: { instanceId: string; companyId: string; publicKey: string; privateKey: KeyObject };
  let refusingPeer: { instanceId: string; companyId: string; publicKey: string; privateKey: KeyObject };
  let refusingServer: Server;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pubsub-delivery-budget-");
    db = createDb(tempDb.connectionString);
    identityDir = await mkdtemp(path.join(tmpdir(), "paperclip-pubsub-delivery-identity-"));
    const local = generateKeyPairSync("ed25519");
    const identityPath = path.join(identityDir, "identity.json");
    await writeFile(identityPath, JSON.stringify({
      version: 1, instanceId: randomUUID(),
      privateKey: local.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }), { mode: 0o600 });
    // Loopback peers are allowlisted by the operator so the egress guard lets
    // the two local test endpoints through.
    service = createPubsubService(db, { identityPath, privatePeerHosts: ["127.0.0.1"] });

    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Delivery budget fixture", issuePrefix: "DB" });

    // Offline for any length of time: a port nothing listens on. Every
    // delivery attempt fails at the network level (transient).
    const offlineKeys = generateKeyPairSync("ed25519");
    offlinePeer = {
      instanceId: randomUUID(), companyId: randomUUID(),
      publicKey: offlineKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKey: offlineKeys.privateKey,
    };
    await db.insert(pubsubTrust).values({
      companyId, peerInstanceId: offlinePeer.instanceId, peerCompanyId: offlinePeer.companyId,
      publicKey: offlinePeer.publicKey, url: "http://127.0.0.1:43299/api/pubsub/deliver",
      topics: ["fleet.chat.*"], revokedAt: null,
    });
    await db.insert(pubsubSubscriptions).values({ companyId, peerInstanceId: offlinePeer.instanceId, topic: "fleet.chat.budget" });

    // Never granted the topic: every attempt is a permanent 403.
    refusingServer = createServer((req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "No explicit PubSub subscription permits this topic" }));
    });
    await new Promise<void>((resolve) => refusingServer.listen(0, "127.0.0.1", resolve));
    const refusingPort = (refusingServer.address() as AddressInfo).port;
    const refusingKeys = generateKeyPairSync("ed25519");
    refusingPeer = {
      instanceId: randomUUID(), companyId: randomUUID(),
      publicKey: refusingKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKey: refusingKeys.privateKey,
    };
    await db.insert(pubsubTrust).values({
      companyId, peerInstanceId: refusingPeer.instanceId, peerCompanyId: refusingPeer.companyId,
      publicKey: refusingPeer.publicKey, url: `http://127.0.0.1:${refusingPort}/api/pubsub/deliver`,
      topics: ["fleet.chat.*"], revokedAt: null,
    });
    await db.insert(pubsubSubscriptions).values({ companyId, peerInstanceId: refusingPeer.instanceId, topic: "fleet.chat.budget" });
  }, 30_000);

  afterAll(async () => {
    refusingServer.close();
    await rm(identityDir, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  async function seedOutboxRow(attempts: number, target: { instanceId: string; companyId: string }) {
    const messageId = randomUUID();
    const local = await service.identity();
    await db.insert(pubsubMessages).values({
      companyId, id: messageId, direction: "outgoing", topic: "fleet.chat.budget",
      payload: { note: "non-deliverable fixture message" },
      fromInstance: local.instanceId, fromCompany: companyId, fromAgent: null, fromRole: "board",
      contentHash: createHash("sha256").update(messageId).digest("hex"),
    });
    await db.insert(pubsubOutbox).values({
      companyId, messageId, peerInstanceId: target.instanceId, peerCompanyId: target.companyId,
      attempts, availableAt: new Date(),
    });
    return messageId;
  }

  it("cancels a permanently rejecting peer once the attempt budget is exhausted", async () => {
    const messageId = await seedOutboxRow(PUBSUB_DELIVERY_MAX_ATTEMPTS - 1, refusingPeer);
    const stop = await service.start();
    try {
      await sleep(700);
      const [row] = await db.select().from(pubsubOutbox).where(eq(pubsubOutbox.messageId, messageId));
      expect(row.deliveredAt).toBeNull();
      expect(row.cancelledAt).not.toBeNull();
      expect(row.attempts).toBe(PUBSUB_DELIVERY_MAX_ATTEMPTS);
      expect(row.lastError).toContain("HTTP 403");
      expect(row.lastError).toContain("delivery budget exhausted");
    } finally {
      await stop();
    }
  });

  it("keeps retrying a transiently unreachable peer past the attempt budget", async () => {
    // The peer has been offline longer than the old fixed budget would cover
    // at the capped backoff. Network-level failures must not consume the
    // budget: the row stays scheduled so the message delivers when the peer
    // comes back, whatever the outage length.
    const messageId = await seedOutboxRow(PUBSUB_DELIVERY_MAX_ATTEMPTS - 1, offlinePeer);
    const stop = await service.start();
    try {
      await sleep(700);
      const [row] = await db.select().from(pubsubOutbox).where(eq(pubsubOutbox.messageId, messageId));
      expect(row.deliveredAt).toBeNull();
      expect(row.cancelledAt).toBeNull();
      expect(row.attempts).toBe(PUBSUB_DELIVERY_MAX_ATTEMPTS);
      expect(row.lastError).not.toContain("delivery budget exhausted");
    } finally {
      await stop();
    }
  });
});

describeEmbeddedPostgres("PubSub peer egress allowlist", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let db: Db;
  let identityDir: string;
  let identityPath: string;
  let companyId: string;
  let peerPublicKey: string;
  let publicService: PubsubService;
  let loopbackService: PubsubService;

  function trustInput(url: string) {
    return {
      companyId, peerInstanceId: randomUUID(), peerCompanyId: randomUUID(),
      publicKey: peerPublicKey, url, topics: ["fleet.chat.*"],
    };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pubsub-egress-allowlist-");
    db = createDb(tempDb.connectionString);
    identityDir = await mkdtemp(path.join(tmpdir(), "paperclip-pubsub-egress-identity-"));
    const local = generateKeyPairSync("ed25519");
    identityPath = path.join(identityDir, "identity.json");
    await writeFile(identityPath, JSON.stringify({
      version: 1, instanceId: randomUUID(),
      privateKey: local.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }), { mode: 0o600 });
    // No allowlist by default: only public destinations may be trusted.
    publicService = createPubsubService(db, { identityPath });
    loopbackService = createPubsubService(db, { identityPath, privatePeerHosts: ["127.0.0.1"] });
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Egress allowlist fixture", issuePrefix: "EA" });
    const peerKeys = generateKeyPairSync("ed25519");
    peerPublicKey = peerKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
  }, 30_000);

  afterAll(async () => {
    await rm(identityDir, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("rejects a private literal destination unless the operator allowlists that host", async () => {
    await expect(publicService.addTrust(trustInput("https://10.0.0.5:8443/api/pubsub/deliver")))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("private or reserved") });
    // The same URL is accepted once the exact host is on the operator allowlist.
    const allowlisted = createPubsubService(db, { identityPath, privatePeerHosts: ["10.0.0.5"] });
    const row = await allowlisted.addTrust(trustInput("https://10.0.0.5:8443/api/pubsub/deliver"));
    expect(row.url).toBe("https://10.0.0.5:8443/api/pubsub/deliver");
  });

  it("rejects a hostname that resolves to a private address", async () => {
    // The URL looks public; only the resolved address gives it away.
    const dnsPinnedService = createPubsubService(db, {
      identityPath,
      peerDnsLookup: async () => [{ address: "192.168.1.10", family: 4 }],
    });
    await expect(dnsPinnedService.addTrust(trustInput("https://peer.internal.example:8443/api/pubsub/deliver")))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("private or reserved") });
  });

  it("keeps link-local denied even when the operator allowlists it", async () => {
    const linkLocalService = createPubsubService(db, { identityPath, privatePeerHosts: ["169.254.169.254"] });
    await expect(linkLocalService.addTrust(trustInput("https://169.254.169.254:8443/api/pubsub/deliver")))
      .rejects.toMatchObject({ status: 400 });
  });

  it("accepts an allowlisted loopback peer and stores the normalized URL", async () => {
    const row = await loopbackService.addTrust(trustInput("http://localhost:3100/api/pubsub/deliver"));
    expect(row.url).toBe("http://127.0.0.1:3100/api/pubsub/deliver");
  });
});

describeEmbeddedPostgres("PubSub wake re-arm after worker restart", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let db: Db;
  let service: PubsubService;
  let identityDir: string;
  let companyId: string;
  let ceoId: string;
  const wakeCalls: string[] = [];

  async function seedMessage(wakePending: 0 | 1, wakeAvailableAt?: Date) {
    const messageId = randomUUID();
    await db.insert(pubsubMessages).values({
      companyId, id: messageId, direction: "incoming", topic: "fleet.chat.rearm",
      payload: { note: "rearm fixture" },
      fromInstance: randomUUID(), fromCompany: randomUUID(), fromAgent: null, fromRole: "board",
      contentHash: createHash("sha256").update(messageId).digest("hex"),
      // Receive() stores the full signed envelope; the wake loop skips its
      // callback for rows without one, so the fixture must carry an envelope
      // for the re-armed wake to reach the (failing) stub.
      envelope: { version: 1, id: messageId, from_role: "board", to_topic: "fleet.chat.rearm", payload: { note: "rearm fixture" } },
      wakePending,
      wakeAvailableAt: wakeAvailableAt ?? new Date(),
    });
    return messageId;
  }

  async function seedReceipt(messageId: string, status: string, error: string | null, sharedKey?: { peer: string; fromCompany: string }) {
    const key = sharedKey ?? { peer: randomUUID(), fromCompany: randomUUID() };
    await db.insert(agentWakeupRequests).values({
      companyId, agentId: ceoId, source: "automation", status, error,
      idempotencyKey: `pubsub:${companyId}:${key.peer}:${key.fromCompany}:${messageId}`,
    });
    return key;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pubsub-rearm-");
    db = createDb(tempDb.connectionString);
    identityDir = await mkdtemp(path.join(tmpdir(), "paperclip-pubsub-rearm-identity-"));
    const local = generateKeyPairSync("ed25519");
    const identityPath = path.join(identityDir, "identity.json");
    await writeFile(identityPath, JSON.stringify({
      version: 1, instanceId: randomUUID(),
      privateKey: local.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }), { mode: 0o600 });
    // A failing wake callback keeps re-armed rows in wake_pending so the
    // selection under test is observable without a real heartbeat.
    service = createPubsubService(db, {
      identityPath,
      wake: async (cid, item) => { wakeCalls.push(item.id); throw new Error("heartbeat unavailable in fixture"); },
    });
    companyId = randomUUID();
    ceoId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Rearm fixture", issuePrefix: "RA" });
    await db.insert(agents).values({ id: ceoId, companyId, name: "Fixture CEO", role: "ceo", status: "active", adapterType: "paperclip_runner" });
  }, 30_000);

  afterAll(async () => {
    await rm(identityDir, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("re-arms budget-pause cancellations but leaves operator stops and delivered receipts suppressed", async () => {
    const budgetPaused = await seedMessage(0);
    const operatorStopped = await seedMessage(0);
    const delivered = await seedMessage(0);
    await seedReceipt(budgetPaused, "cancelled", "Cancelled due to budget pause");
    await seedReceipt(operatorStopped, "cancelled", "Stopped by operator");
    await seedReceipt(delivered, "completed", null);

    const stop = await service.start();
    try {
      await sleep(700);
      const rows = await db.select().from(pubsubMessages).where(eq(pubsubMessages.companyId, companyId));
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      expect(byId[budgetPaused].wakePending).toBe(1);
      expect(byId[budgetPaused].wakeAttempts).toBeGreaterThanOrEqual(1);
      expect(byId[operatorStopped].wakePending).toBe(0);
      expect(byId[operatorStopped].wakeAttempts).toBe(0);
      expect(byId[delivered].wakePending).toBe(0);
      expect(byId[delivered].wakeAttempts).toBe(0);
      expect(wakeCalls).toEqual(expect.arrayContaining([budgetPaused]));
      expect(wakeCalls).not.toEqual(expect.arrayContaining([operatorStopped, delivered]));
    } finally {
      await stop();
    }
  });

  it("does not re-arm a stale receipt once a later attempt delivered or stopped the wake", async () => {
    // The first attempt's budget-pause cancellation (or skipped receipt) stays
    // on the books after a later attempt durably delivered the wake or an
    // operator stopped it: the sweep must not re-arm those messages, or it
    // redoes the work every tick and holds the rows' wake_pending flag against
    // the retention sweep.
    const staleDelivered = await seedMessage(0);
    const key = await seedReceipt(staleDelivered, "cancelled", "Cancelled due to budget pause");
    await seedReceipt(staleDelivered, "completed", null, key);
    const staleStopped = await seedMessage(0);
    const stopKey = await seedReceipt(staleStopped, "skipped", "heartbeat.scheduling_suppressed");
    await seedReceipt(staleStopped, "cancelled", "Stopped by operator", stopKey);

    const stop = await service.start();
    try {
      await sleep(700);
      const rows = await db.select().from(pubsubMessages).where(eq(pubsubMessages.companyId, companyId));
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      expect(byId[staleDelivered].wakePending).toBe(0);
      expect(byId[staleDelivered].wakeAttempts).toBe(0);
      expect(byId[staleStopped].wakePending).toBe(0);
      expect(byId[staleStopped].wakeAttempts).toBe(0);
    } finally {
      await stop();
    }
  });

  it("preserves an active wake backoff instead of overriding it with now", async () => {
    const deferred = await seedMessage(0, new Date(Date.now() + 300_000));
    await seedReceipt(deferred, "cancelled", "Cancelled due to budget pause");
    const stop = await service.start();
    try {
      await sleep(700);
      const [row] = await db.select().from(pubsubMessages).where(and(
        eq(pubsubMessages.companyId, companyId),
        eq(pubsubMessages.id, deferred),
      ));
      expect(row.wakePending).toBe(1);
      // The re-arm happened, but the worker's backoff survived it: the wake
      // has not run yet and stays deferred past the test window.
      expect(row.wakeAvailableAt.getTime()).toBeGreaterThan(Date.now() + 200_000);
      expect(row.wakeAttempts).toBe(0);
    } finally {
      await stop();
    }
  });
});
