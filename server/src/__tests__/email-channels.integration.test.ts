import { applyConnectorSkills, prepareConnectorSkillDelivery, resolveConnectorAssignments, annotateConnectorSkills } from "../services/connector-runtime.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { renderPaperclipWakePrompt, resolvePaperclipDesiredSkillNames, resolveLegacyPaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";
import express from "express";
import type WebSocket from "ws";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import * as remoteHttp from "../services/remote-http-fetch.js";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { Webhook } from "svix";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  createDb,
  companies,
  agents,
  chatEndpoints,
  chatConversations,
  chatDeliveries,
  chatPublications,
  emailEndpoints,
  emailMessages,
  emailSends,
  issueComments,
  heartbeatRuns,
  issues,
  authUsers,
  companyMemberships,
  toolConnections,
  toolConnectionInstalls,
  connectionGrants,
  projects,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  emailChannelService,
  type EmailChannelService,
} from "../services/email-channels.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import {
  agentmailMessageSchema,
  type AgentmailMessage,
} from "../services/agentmail-api.js";
import { emailConnectionService } from "../services/email-connections.js";
import { toolAccessService } from "../services/tool-access.js";
import { emailSendSchema } from "@paperclipai/shared";
import { chatChannelService } from "../services/chat-channels.js";

describe("AgentMail durable email pipeline", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const folder = mkdtempSync(path.join(os.tmpdir(), "paperclip-email-"));
  const previous = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const services: EmailChannelService[] = [];
  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
      folder,
      "master.key",
    );
    database = await startEmbeddedPostgresTestDatabase("paperclip-email-");
    db = createDb(database.connectionString);
    await instanceSettingsService(db).updateExperimental({
      enableChatConnectors: true,
    });
    await db.insert(authUsers).values({
      id: "email-board",
      name: "Email Board",
      email: "board@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }, 60_000);
  afterEach(async () => {
    for (const service of services.splice(0)) await service.shutdown();
    vi.restoreAllMocks();
    await db
      .update(chatEndpoints)
      .set({ status: "paused" })
      .where(
        and(
          eq(chatEndpoints.provider, "agentmail"),
          ne(chatEndpoints.status, "archived"),
        ),
      );
  });
  afterAll(async () => {
    await database?.cleanup();
    if (previous === undefined)
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previous;
    rmSync(folder, { recursive: true, force: true });
  });
  it("installs one connector skill and provider tools only for the assigned agent", async () => {
    const f = await fixture();
    const binding = { companyId: f.companyId, agentId: f.agentId };
    const assignments = await resolveConnectorAssignments(db, binding);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].resources[0].id).toBe(f.endpointId);
    const base = { paperclipSkillSync: { desiredSkills: [] } };
    const configured = await applyConnectorSkills(base, [], assignments);
    expect(base.paperclipSkillSync.desiredSkills).toEqual([]);
    expect(resolvePaperclipDesiredSkillNames(configured, configured.paperclipRuntimeSkills)).toEqual(["paperclipai/paperclip/agentmail"]);
    expect(resolveLegacyPaperclipDesiredSkillNames(configured, configured.paperclipRuntimeSkills)).toContain("paperclipai/paperclip/agentmail");
    const markdown = readFileSync(path.join(configured.paperclipRuntimeSkills[0].source, "SKILL.md"), "utf8");
    expect(markdown).toContain(f.endpointId);
    expect(markdown).toContain("agentmail_send");
    expect(markdown).not.toContain("test-key");
    for (const adapterType of ["cursor_local", "gemini_local", "opencode_local", "pi_local", "codex_local"]) {
      const delivery = await prepareConnectorSkillDelivery(configured, adapterType);
      expect(delivery.config.paperclipRuntimeSkills).toEqual([]);
      expect(delivery.config.paperclipConnectorSkillDigest).toBe(configured.paperclipConnectorSkillDigest);
      for (const resumedSession of [false, true]) {
        expect(renderPaperclipWakePrompt({ connectorSkillInstructions: delivery.instructions }, { resumedSession })).toContain(f.endpointId);
      }
    }
    const nativeDelivery = await prepareConnectorSkillDelivery(configured, "paperclip_runner");
    expect(nativeDelivery.instructions).toBe("");
    expect(nativeDelivery.config.paperclipRuntimeSkills).toHaveLength(1);
    const authority = new PaperclipRunnerToolAuthority(db, { ...binding, issueId: randomUUID(), runId: randomUUID(), connectorAssignments: assignments });
    expect(authority.definitions().filter((tool) => String(tool.name).startsWith("agentmail_")).map((tool) => tool.name)).toEqual([
      "agentmail_inboxes", "agentmail_read_thread", "agentmail_send", "agentmail_delivery",
    ]);
    expect(authority.definitions().some((tool) => tool.name === "task_email")).toBe(false);
    expect(await resolveConnectorAssignments(db, { ...binding, agentId: randomUUID() })).toEqual([]);
    expect(await resolveConnectorAssignments(db, { ...binding, companyId: randomUUID() })).toEqual([]);
    const disconnected = await applyConnectorSkills(configured, configured.paperclipRuntimeSkills, []);
    expect(disconnected.paperclipRuntimeSkills).toEqual([]);
    expect(disconnected.paperclipConnectorSkillDigest).toBeNull();
    expect(resolvePaperclipDesiredSkillNames(disconnected, [])).toEqual([]);
    expect(new PaperclipRunnerToolAuthority(db, { ...binding, issueId: randomUUID(), runId: randomUUID() }).definitions().some((tool) => String(tool.name).startsWith("agentmail_"))).toBe(false);
    const snapshot = annotateConnectorSkills({ adapterType: "codex_local", supported: true, mode: "ephemeral", desiredSkills: [assignments[0].skillKey], entries: [{ key: assignments[0].skillKey, runtimeName: "agentmail", desired: true, managed: true, state: "configured" }], warnings: [] }, assignments);
    expect(snapshot.entries[0]).toMatchObject({ readOnly: true, originLabel: "AgentMail assignment" });
    expect(snapshot.entries[0].detail).toContain(assignments[0].resources[0].label);
    await db.update(chatEndpoints).set({ status: "paused" }).where(eq(chatEndpoints.id, f.endpointId));
    expect(await resolveConnectorAssignments(db, binding)).toEqual([]);
  });

  it("deduplicates multiple inboxes into one skill and changes the runtime bundle on reassignment", async () => {
    const first = await fixture();
    const second = await fixture();
    const binding = { companyId: first.companyId, agentId: first.agentId };
    const before = await applyConnectorSkills({}, [], await resolveConnectorAssignments(db, binding));
    await second.service.control(second.endpointId, "remove", { userId: "email-board" });
    const extra = await second.service.setup(first.companyId, {
      assignedAgentId: first.agentId, apiKey: "test-key", inboxId: second.address,
      receiveMode: "websocket", idempotencyKey: randomUUID(),
    }, { userId: "email-board" });
    const assignments = await resolveConnectorAssignments(db, binding);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].resources).toHaveLength(2);
    const after = await applyConnectorSkills(before, before.paperclipRuntimeSkills, assignments);
    expect(after.paperclipRuntimeSkills).toHaveLength(1);
    expect(after.paperclipConnectorSkillDigest).not.toBe(before.paperclipConnectorSkillDigest);
    expect(after.paperclipRuntimeSkills[0].source).not.toBe(before.paperclipRuntimeSkills[0].source);
    const markdown = readFileSync(path.join(after.paperclipRuntimeSkills[0].source, "SKILL.md"), "utf8");
    expect(markdown).toContain(first.address);
    expect(markdown).toContain(second.address);
    await second.service.control(extra.id, "remove", { userId: "email-board" });
    expect((await resolveConnectorAssignments(db, binding))[0].resources).toHaveLength(1);
  });

  it("removes connector contributions when the experimental gate or credential access is revoked", async () => {
    const f = await fixture();
    const binding = { companyId: f.companyId, agentId: f.agentId };
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: false });
    try { expect(await resolveConnectorAssignments(db, binding)).toEqual([]); }
    finally { await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true }); }
    const endpoint = await f.service.getEndpoint(f.endpointId);
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, endpoint.connectionId));
    expect(await resolveConnectorAssignments(db, binding)).toEqual([]);
  });

  it("can replay the additive email migration without losing existing data", async () => {
    const migration = readFileSync(new URL("../../../packages/db/src/migrations/0272_light_kate_bishop.sql", import.meta.url), "utf8");
    await db.execute(sql.raw(migration));
    await db.execute(sql.raw(migration));
    expect(await db.select().from(authUsers).where(eq(authUsers.id, "email-board"))).toHaveLength(1);
  });

  async function fixture(mode: "websocket" | "webhook" = "webhook", storage?: StorageService) {
    const companyId = randomUUID(),
      agentId = randomUUID(),
      endpointId = randomUUID();
    const address = `${endpointId}@agentmail.to`;
    await db.insert(companies).values({
      id: companyId,
      name: "Email test",
      issuePrefix: `E${companyId.slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalId: "email-board",
      principalType: "user",
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Email agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const messages = new Map<string, AgentmailMessage>();
    const sends: { key: string; body: any; path: string }[] = [];
    let sendError = 0;
    let webhookError = 0;
    let beforeSendResponse:
      | ((message: AgentmailMessage) => Promise<void>)
      | undefined;
    const fetcher = vi.fn(async (url: any, init: any) => {
      const u = new URL(String(url)),
        pathname = decodeURIComponent(u.pathname);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (pathname === "/v0/auth/me")
        return json({
          scope_type: "inbox",
          organization_id: "organization",
          inbox_id: address,
        });
      if (pathname === `/v0/inboxes/${address}`)
        return json({ inbox_id: address });
      if (pathname.endsWith("/webhooks") && webhookError) return json({}, webhookError);
      if (pathname.endsWith("/webhooks"))
        return json({
          webhook_id: "owned-webhook",
          secret: `whsec_${Buffer.from("test-webhook-secret").toString("base64")}`,
        });
      if (
        init.method === "POST" &&
        (pathname.endsWith("/messages/send") || pathname.endsWith("/reply"))
      ) {
        const body = JSON.parse(init.body),
          key = init.headers["Idempotency-Key"];
        sends.push({ key, body, path: pathname });
        if (sendError) return json({}, sendError);
        const m = message(`sent-${key}`, "outbound-thread", {
          from: address,
          labels: ["sent"],
          text: body.text,
          headers: body.headers,
          to: body.to ?? ["sender@example.test"],
        });
        messages.set(m.message_id, m);
        await beforeSendResponse?.(m);
        return json({ message_id: m.message_id, thread_id: m.thread_id });
      }
      if (pathname.includes("/threads/"))
        return json({
          messages: [...messages.values()].filter(
            (m) => m.thread_id === pathname.split("/threads/")[1],
          ),
        });
      if (pathname.endsWith("/messages"))
        return json({
          messages: [...messages.values()].map((m) => ({
            message_id: m.message_id,
          })),
        });
      if (pathname.includes("/attachments/")) return json({ download_url: "https://attachments.example.test/context", size: 12 });
      if (pathname.includes("/messages/")) {
        const m = messages.get(pathname.split("/messages/")[1]);
        return json(m ?? {}, m ? 200 : 404);
      }
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`Unexpected test request: ${pathname}`);
    }) as unknown as typeof fetch;
    const wakeup = vi.fn().mockResolvedValue(null);
    const socket = new EventTarget() as EventTarget & {
      close: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
    };
    socket.close = vi.fn(() => socket.dispatchEvent(new Event("close")));
    socket.send = vi.fn();
    const createSocket = vi.fn(() => socket as unknown as WebSocket);
    const service = emailChannelService(db, {
      heartbeat: { wakeup },
      fetch: fetcher,
      publicBaseUrl: "https://paperclip.example.test",
      createSocket,
      storage,
    });
    services.push(service);
    await service.setup(
      companyId,
      {
        assignedAgentId: agentId,
        apiKey: "test-key",
        inboxId: address,
        receiveMode: mode,
        idempotencyKey: endpointId,
      },
      { userId: "email-board" },
    );
    function message(
      id = randomUUID(),
      thread = randomUUID(),
      extra: Partial<AgentmailMessage> = {},
    ) {
      return agentmailMessageSchema.parse({
        inbox_id: address,
        message_id: id,
        thread_id: thread,
        from: "sender@example.test",
        to: [address],
        subject: "Same subject",
        text: "Hello",
        timestamp: new Date(Date.now() + 1000).toISOString(),
        labels: ["received"],
        ...extra,
      });
    }
    async function receive(m: AgentmailMessage, kind = "message.received") {
      messages.set(m.message_id, m);
      await service.admit(await service.getEndpoint(endpointId), {
        event_type: kind,
        message: m,
      });
      await service.tick();
    }
    return {
      companyId,
      agentId,
      endpointId,
      address,
      service,
      wakeup,
      messages,
      sends,
      message,
      receive,
      socket,
      createSocket,
      fetcher,
      setBeforeSendResponse: (
        callback: (message: AgentmailMessage) => Promise<void>,
      ) => {
        beforeSendResponse = callback;
      },
      setSendError: (status: number) => {
        sendError = status;
      },
      setWebhookError: (status: number) => { webhookError = status; },
    };
  }
  it("admits signed webhooks through the durable queue and rejects a valid signature for another inbox", async () => {
    const f = await fixture();
    const endpoint = await f.service.getEndpoint(f.endpointId);
    const message = f.message();
    f.messages.set(message.message_id, message);
    const secret = `whsec_${Buffer.from("test-webhook-secret").toString("base64")}`;
    const deliver = (inboxId: string) => {
      const body = JSON.stringify({
        event_type: "message.received",
        message: { ...message, inbox_id: inboxId },
      });
      const timestamp = new Date();
      const id = randomUUID();
      return f.service.webhook(endpoint.publicId, Buffer.from(body), {
        "svix-id": id,
        "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
        "svix-signature": new Webhook(secret).sign(id, timestamp, body),
      });
    };
    await expect(deliver("someone-else@agentmail.to")).rejects.toThrow(
      /inbox/i,
    );
    await deliver(f.address);
    await deliver(f.address);
    expect(f.wakeup).not.toHaveBeenCalled();
    await f.service.tick();
    expect(f.wakeup).toHaveBeenCalledTimes(1);
    expect(
      await db.select().from(issues).where(eq(issues.companyId, f.companyId)),
    ).toHaveLength(1);
  });
  it("deduplicates events/messages, keeps identical subjects separate, and never grants sender board identity", async () => {
    const f = await fixture();
    const m = f.message();
    await f.receive(m);
    await f.receive(m);
    const tasks = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, f.companyId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assigneeAgentId).toBe(f.agentId);
    expect(tasks[0].createdByUserId).toBeNull();
    expect(
      await db
        .select()
        .from(emailMessages)
        .where(eq(emailMessages.companyId, f.companyId)),
    ).toHaveLength(1);
    expect(f.wakeup).toHaveBeenCalledTimes(1);
    await f.receive(f.message());
    expect(
      await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.companyId, f.companyId)),
    ).toHaveLength(2);
    expect(f.sends).toHaveLength(0);
  });
  it("imports context once, reopens done tasks, and retains cancelled replies without wakes", async () => {
    const f = await fixture();
    const old = f.message("old", "thread", {
      timestamp: "2020-01-01T00:00:00Z",
    });
    f.messages.set(old.message_id, old);
    await f.receive(f.message("new", "thread"));
    const [c] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.companyId, f.companyId));
    expect(
      (await f.service.thread(f.companyId, c.issueId))?.messages,
    ).toHaveLength(2);
    await f.receive(old);
    expect(f.wakeup).toHaveBeenCalledTimes(1);
    await issueService(db).update(c.issueId, { status: "done" });
    await f.receive(f.message("reply", "thread"));
    expect((await issueService(db).getById(c.issueId))?.status).toBe("todo");
    await issueService(db).update(c.issueId, { status: "cancelled" });
    await f.receive(f.message("cancelled-reply", "thread"));
    expect(f.wakeup).toHaveBeenCalledTimes(2);
    expect(
      (await f.service.thread(f.companyId, c.issueId))?.messages,
    ).toHaveLength(4);
  });
  it("filters spam and automatic conversations and escapes remote Markdown images", async () => {
    const f = await fixture();
    await f.receive(f.message("spam", "spam", { labels: ["spam"] }));
    await f.receive(
      f.message("auto", "auto", {
        headers: { "Auto-Submitted": "auto-replied" },
      }),
    );
    expect(f.wakeup).not.toHaveBeenCalled();
    await f.receive(
      f.message("safe", "safe", {
        extracted_text: "![tracker](https://evil.test/pixel)",
      }),
    );
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.companyId, f.companyId));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("\\!\\[tracker\\]");
  });
  it("persists an email child and immutable intent before sending and deduplicates retries", async () => {
    const f = await fixture();
    const parent = await issueService(db).create(f.companyId, {
      title: "Parent",
      status: "todo",
      assigneeAgentId: f.agentId,
    });
    const input = emailSendSchema.parse({
      endpointId: f.endpointId,
      parentIssueId: parent.id,
      to: ["recipient@example.test"],
      bcc: ["private@example.test"],
      subject: "Hello",
      text: "Deliberate send",
      idempotencyKey: randomUUID(),
    });
    const queued = await f.service.queueSend(f.companyId, input, {
      userId: "email-board",
    });
    expect(f.sends).toHaveLength(0);
    expect(queued.outcome).toBe("queued");
    expect((await issueService(db).getById(queued.issueId))?.parentId).toBe(
      parent.id,
    );
    expect(
      await f.service.queueSend(f.companyId, input, { userId: "email-board" }),
    ).toEqual(queued);
    await expect(
      f.service.queueSend(
        f.companyId,
        { ...input, text: "Changed" },
        { userId: "email-board" },
      ),
    ).rejects.toThrow(/different content/);
    await f.service.tick();
    await f.service.tick();
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].key).toBe(input.idempotencyKey);
    expect((await f.service.publication(queued.id, f.companyId)).outcome).toBe(
      "sent",
    );
    expect(
      (await f.service.thread(f.companyId, queued.issueId))?.messages,
    ).toHaveLength(1);
    expect(f.wakeup).not.toHaveBeenCalled();
    const sent = f.messages.get(`sent-${input.idempotencyKey}`)!;
    await f.receive(sent, "message.bounced");
    // A reply imports the sent message again as thread context. That must not
    // erase the delivery failure explanation or downgrade the receipt.
    await f.receive(f.message("reply-after-bounce", sent.thread_id));
    expect(await f.service.publication(queued.id, f.companyId)).toMatchObject({
      outcome: "failed",
      error: "AgentMail reported message.bounced",
    });
  });

  it("imports attachments once, bounds intake, and validates stored attachments before sending", async () => {
    const objects = new Map<string, Buffer>();
    const storage = createStorageService({
      id: "local_disk",
      async putObject(input) { objects.set(input.objectKey, input.body as Buffer); },
      async getObject(input) { return { stream: Readable.from([objects.get(input.objectKey)!]) }; },
      async headObject(input) { return { exists: objects.has(input.objectKey) }; },
      async deleteObject(input) { objects.delete(input.objectKey); },
    });
    const download = vi.spyOn(remoteHttp, "guardedRemoteHttpFetch")
      .mockImplementation(async () => new Response("mail context"));
    const f = await fixture("webhook", storage);
    const mail = f.message(undefined, undefined, { attachments: [
      { attachment_id: "context", filename: "../context.txt", content_type: "text/plain", size: 12 },
      { attachment_id: "oversized", filename: "large.txt", content_type: "text/plain", size: MAX_ATTACHMENT_BYTES + 1 },
    ] });
    await f.receive(mail);
    await f.receive(mail);
    const [binding] = await db.select().from(chatConversations).where(eq(chatConversations.endpointId, f.endpointId));
    const thread = await f.service.thread(f.companyId, binding.issueId);
    expect(thread!.messages[0].attachmentIds).toHaveLength(1);
    expect(download).toHaveBeenCalledTimes(1);
    const attachmentId = thread!.messages[0].attachmentIds[0];
    const attachment = await issueService(db).getAttachmentById(attachmentId);
    expect(attachment).toMatchObject({ companyId: f.companyId, issueId: binding.issueId, byteSize: 12, originalFilename: "context.txt" });
    const input = emailSendSchema.parse({ endpointId: f.endpointId, parentIssueId: binding.issueId,
      to: ["recipient@example.test"], subject: "Stored attachment", text: "Context attached",
      attachmentIds: [attachmentId], idempotencyKey: randomUUID() });
    const wrongTask = await issueService(db).create(f.companyId, { title: "Other task", status: "todo", assigneeAgentId: f.agentId });
    await expect(f.service.queueSend(f.companyId, { ...input, parentIssueId: wrongTask.id }, { userId: "email-board" }))
      .rejects.toThrow("attachments must belong to the source task");
    const queued = await f.service.queueSend(f.companyId, input, { userId: "email-board" });
    await f.service.tick();
    expect(await f.service.publication(queued.id, f.companyId)).toMatchObject({ outcome: "sent", error: null });
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].body.attachments).toEqual([{ filename: "context.txt", content_type: "text/plain", content: Buffer.from("mail context").toString("base64") }]);
    const changed = await f.service.queueSend(f.companyId, { ...input, idempotencyKey: randomUUID() }, { userId: "email-board" });
    objects.set(attachment!.objectKey, Buffer.from("changed data"));
    await f.service.tick();
    expect((await f.service.publication(changed.id, f.companyId)).outcome).toBe("failed");
    expect(f.sends).toHaveLength(1);
  });
  it("retries transient sends with the same key and stops beyond the idempotency window", async () => {
    const f = await fixture();
    f.setSendError(503);
    const parent = await issueService(db).create(f.companyId, {
      title: "Parent",
      status: "todo",
      assigneeAgentId: f.agentId,
    });
    const input = emailSendSchema.parse({
      endpointId: f.endpointId,
      parentIssueId: parent.id,
      to: ["recipient@example.test"],
      subject: "Hello",
      text: "Send",
      idempotencyKey: randomUUID(),
    });
    await f.service.queueSend(f.companyId, input, { userId: "email-board" });
    await f.service.tick();
    expect(
      (await f.service.publication(input.idempotencyKey, f.companyId)).outcome,
    ).toBe("uncertain");
    await db
      .update(chatPublications)
      .set({ nextAttemptAt: null })
      .where(eq(chatPublications.id, input.idempotencyKey));
    await f.service.tick();
    expect(f.sends).toHaveLength(2);
    expect(f.sends[1].key).toBe(f.sends[0].key);
    await db
      .update(emailSends)
      .set({ firstAttemptAt: new Date(Date.now() - 25 * 60 * 60_000) })
      .where(eq(emailSends.publicationId, input.idempotencyKey));
    await db
      .update(chatPublications)
      .set({ nextAttemptAt: null })
      .where(eq(chatPublications.id, input.idempotencyKey));
    await f.service.tick();
    await f.service.tick();
    expect(f.sends).toHaveLength(2);
  });
  it("isolates companies and inboxes, and revoked board membership fails queued sends without calling the provider", async () => {
    const f = await fixture();
    const parent = await issueService(db).create(f.companyId, {
      title: "Parent",
      status: "todo",
      assigneeAgentId: f.agentId,
    });
    const input = emailSendSchema.parse({
      endpointId: f.endpointId,
      parentIssueId: parent.id,
      to: ["recipient@example.test"],
      subject: "Hello",
      text: "Send",
      idempotencyKey: randomUUID(),
    });
    await expect(
      f.service.queueSend(randomUUID(), input, { userId: "email-board" }),
    ).rejects.toThrow("Email inbox not found");
    await expect(
      f.service.admit(await f.service.getEndpoint(f.endpointId), {
        event_type: "message.received",
        message: { inbox_id: "other@agentmail.to", message_id: "foreign" },
      }),
    ).rejects.toThrow(/different inbox/);
    await expect(
      f.service.queueSend(f.companyId, input, {
        agentId: randomUUID(),
        runId: randomUUID(),
      }),
    ).rejects.toThrow(/assigned agent/);
    await f.service.queueSend(f.companyId, input, { userId: "email-board" });
    await db
      .update(companyMemberships)
      .set({ status: "suspended" })
      .where(eq(companyMemberships.companyId, f.companyId));
    await f.service.tick();
    expect(f.sends).toHaveLength(0);
    expect(
      (await f.service.publication(input.idempotencyKey, f.companyId)).outcome,
    ).toBe("failed");
  });
  it("updates delivery receipts once without creating another task or wake", async () => {
    const f = await fixture();
    const parent = await issueService(db).create(f.companyId, {
      title: "Parent",
      status: "todo",
      assigneeAgentId: f.agentId,
    });
    const input = emailSendSchema.parse({
      endpointId: f.endpointId,
      parentIssueId: parent.id,
      to: ["recipient@example.test"],
      subject: "Hello",
      text: "Send",
      idempotencyKey: randomUUID(),
    });
    const queued = await f.service.queueSend(f.companyId, input, {
      userId: "email-board",
    });
    await f.service.tick();
    const sent = f.messages.get(`sent-${input.idempotencyKey}`)!;
    await f.receive(sent, "message.delivered");
    await f.receive(sent, "message.sent");
    expect((await f.service.publication(queued.id, f.companyId)).outcome).toBe(
      "delivered",
    );
    expect(
      (await f.service.thread(f.companyId, queued.issueId))?.messages,
    ).toHaveLength(1);
    expect(
      await db.select().from(issues).where(eq(issues.companyId, f.companyId)),
    ).toHaveLength(2);
    expect(f.wakeup).not.toHaveBeenCalled();
  });
  it("catches up an old Date header received after activation and rejects pre-activation history", async () => {
    const f = await fixture();
    const old = f.message("pre-activation", "history", {
      created_at: "2020-01-01T00:00:00Z",
      timestamp: "2020-01-01T00:00:00Z",
    });
    const fresh = f.message("late-mail", "late", {
      created_at: new Date(Date.now() + 1000).toISOString(),
      timestamp: "2020-01-01T00:00:00Z",
    });
    f.messages.set(old.message_id, old);
    f.messages.set(fresh.message_id, fresh);
    await f.service.tick();
    await f.service.tick();
    expect(
      await db.select().from(issues).where(eq(issues.companyId, f.companyId)),
    ).toHaveLength(1);
    expect(f.wakeup).toHaveBeenCalledTimes(1);
  });
  it("disconnects without deleting the provider inbox and refuses to resume archived endpoints", async () => {
    const f = await fixture();
    await f.receive(f.message());
    const result = await f.service.control(f.endpointId, "remove", {
      userId: "email-board",
    });
    expect(result.status).toBe("archived");
    await expect(
      f.service.control(f.endpointId, "resume", { userId: "email-board" }),
    ).rejects.toThrow(/disconnected/);
    expect(
      await db
        .select()
        .from(emailMessages)
        .where(eq(emailMessages.companyId, f.companyId)),
    ).toHaveLength(1);
  });

  it("reconciles an incoming reply and sent callback before the send response, preserving the pending child", async () => {
    const f = await fixture();
    const second = emailChannelService(db, {
      heartbeat: { wakeup: f.wakeup },
      fetch: f.fetcher,
    });
    services.push(second);
    const parent = await issueService(db).create(f.companyId, {
      title: "Parent",
      status: "todo",
      assigneeAgentId: f.agentId,
    });
    const input = emailSendSchema.parse({
      endpointId: f.endpointId,
      parentIssueId: parent.id,
      to: ["recipient@example.test"],
      subject: "Hello",
      text: "Send",
      idempotencyKey: randomUUID(),
    });
    const queued = await f.service.queueSend(f.companyId, input, {
      userId: "email-board",
    });
    f.setBeforeSendResponse(async (sent) => {
      const reply = f.message("fast-reply", sent.thread_id);
      f.messages.set(reply.message_id, reply);
      const endpoint = await second.getEndpoint(f.endpointId);
      await second.admit(endpoint, {
        event_type: "message.received",
        message: reply,
      });
      await second.admit(endpoint, {
        event_type: "message.sent",
        message: sent,
      });
      await second.tick();
    });
    await f.service.tick();
    await f.service.tick();
    expect(f.sends).toHaveLength(1);
    expect(
      await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.companyId, f.companyId)),
    ).toHaveLength(1);
    const thread = await f.service.thread(f.companyId, queued.issueId);
    expect(thread?.messages).toHaveLength(2);
    expect(thread?.publications[0].outcome).toBe("sent");
    expect(f.wakeup).toHaveBeenCalledTimes(1);
  });
  it("retries the durable inbound wake after a failure and worker restart without duplicating mail", async () => {
    const f = await fixture();
    f.wakeup.mockRejectedValueOnce(new Error("Wake service temporarily unavailable"));
    await f.receive(f.message());
    const [pending] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, f.endpointId));
    expect(pending.state).toBe("retry");
    expect(pending.normalizedEvent).toMatchObject({ issueId: expect.any(String), wakePending: true });
    await f.service.shutdown();
    const restarted = emailChannelService(db, { heartbeat: { wakeup: f.wakeup }, fetch: f.fetcher });
    services.push(restarted);
    await db.update(chatDeliveries).set({ nextAttemptAt: null }).where(eq(chatDeliveries.id, pending.id));
    await restarted.tick();
    expect(f.wakeup).toHaveBeenCalledTimes(2);
    expect(f.wakeup.mock.calls[1][1]).toEqual(f.wakeup.mock.calls[0][1]);
    const [finished] = await db.select().from(chatDeliveries).where(eq(chatDeliveries.id, pending.id));
    expect(finished.state).toBe("processed");
    expect(finished.normalizedEvent).toMatchObject({ wakePending: false });
    expect(await db.select().from(emailMessages).where(eq(emailMessages.endpointId, f.endpointId))).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId))).toHaveLength(1);
  });

  it("removes a newly registered webhook when setup cannot persist its identity", async () => {
    const f = await fixture("websocket");
    await db.update(chatEndpoints).set({ status: "draft" }).where(eq(chatEndpoints.id, f.endpointId));
    await db.execute(sql.raw(`
      CREATE FUNCTION fail_email_webhook_write() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'simulated webhook persistence failure'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_email_webhook_write BEFORE UPDATE ON email_endpoints
      FOR EACH ROW WHEN (NEW.webhook_id IS NOT NULL) EXECUTE FUNCTION fail_email_webhook_write();
    `));
    try {
      await expect(f.service.setup(f.companyId, {
        assignedAgentId: f.agentId, apiKey: "test-key", inboxId: f.address,
        receiveMode: "webhook", idempotencyKey: f.endpointId,
      }, { userId: "email-board" })).rejects.toThrow();
      expect(vi.mocked(f.fetcher).mock.calls.some(([url, init]) =>
        String(url).endsWith("/webhooks/owned-webhook") && init?.method === "DELETE",
      )).toBe(true);
      const [config] = await db.select().from(emailEndpoints).where(eq(emailEndpoints.endpointId, f.endpointId));
      expect(config.webhookId).toBeNull();
      expect((await f.service.getEndpoint(f.endpointId)).status).toBe("draft");
    } finally {
      await db.execute(sql.raw("DROP TRIGGER fail_email_webhook_write ON email_endpoints; DROP FUNCTION fail_email_webhook_write();"));
    }
  });

  it("leases WebSocket ownership across workers, subscribes, and deduplicates WebSocket/webhook-shaped events", async () => {
    const f = await fixture("websocket");
    const secondSocket = vi.fn((): WebSocket => {
      throw new Error("Second worker must not own the socket");
    });
    const second = emailChannelService(db, {
      heartbeat: { wakeup: f.wakeup },
      fetch: f.fetcher,
      createSocket: secondSocket,
    });
    services.push(second);
    await f.service.tick();
    await second.tick();
    expect(f.createSocket).toHaveBeenCalledTimes(1);
    expect(f.createSocket).toHaveBeenCalledWith(
      "wss://ws.agentmail.to/v0",
      { headers: { Authorization: "Bearer test-key" } },
    );
    expect(secondSocket).not.toHaveBeenCalled();
    f.socket.dispatchEvent(new Event("open"));
    expect(JSON.parse(f.socket.send.mock.calls[0][0])).toMatchObject({
      type: "subscribe",
      inbox_ids: [f.address],
    });
    f.socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "subscribed" }),
      }),
    );
    const m = f.message();
    f.messages.set(m.message_id, m);
    f.socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "message_received", message: m }),
      }),
    );
    await vi.waitFor(async () =>
      expect(
        await db
          .select()
          .from(chatDeliveries)
          .where(eq(chatDeliveries.endpointId, f.endpointId)),
      ).toHaveLength(1),
    );
    await f.receive(m);
    expect(f.wakeup).toHaveBeenCalledTimes(1);
    await f.service.shutdown();
    secondSocket.mockImplementation(() => f.socket as unknown as WebSocket);
    await second.tick();
    expect(secondSocket).toHaveBeenCalledTimes(1);
  });
  it("allows a bound normal agent to queue email, preserves budget limits, and rejects generic chat publication", async () => {
    const f = await fixture();
    await f.receive(f.message());
    const [conversation] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.companyId, f.companyId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: f.companyId,
      agentId: f.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: conversation.issueId,
      contextSnapshot: { issueId: conversation.issueId },
    });
    await db
      .update(issues)
      .set({ executionRunId: runId })
      .where(eq(issues.id, conversation.issueId));
    const binding = {
      companyId: f.companyId,
      agentId: f.agentId,
      runId,
      issueId: conversation.issueId,
      workMode: "standard",
    };
    const request = emailSendSchema.parse({
      endpointId: f.endpointId,
      conversationId: conversation.id,
      replyToMessageId: [...f.messages.keys()][0],
      text: "Explicit agent reply",
      idempotencyKey: randomUUID(),
    });
    const authority = new PaperclipRunnerToolAuthority(db, {
      ...binding, workMode: "standard", connectorAssignments: await resolveConnectorAssignments(db, binding),
    });
    const queued = (await authority.execute({ tool: "agentmail_send", callId: randomUUID(), arguments: { request } })) as { id: string; outcome: string };
    expect(queued.outcome).toBe("queued");
    const assignedEndpoint = await f.service.getEndpoint(f.endpointId);
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, assignedEndpoint.connectionId));
    await expect(authority.execute({ tool: "agentmail_read_thread", callId: randomUUID(), arguments: {} })).rejects.toThrow(/no longer assigned or authorized/);
    await db.update(toolConnections).set({ enabled: true }).where(eq(toolConnections.id, assignedEndpoint.connectionId));
    expect(f.sends).toHaveLength(0);
    const comment = await issueService(db).addComment(
      conversation.issueId,
      "Internal progress",
      { agentId: f.agentId },
    );
    const chat = chatChannelService(db, { heartbeat: { wakeup: f.wakeup } });
    await expect(
      chat.publishComment(f.endpointId, conversation.id, comment.id),
    ).rejects.toThrow(/explicit email/);
    await chat.shutdown();
    await db
      .update(agents)
      .set({ budgetMonthlyCents: 100, spentMonthlyCents: 100 })
      .where(eq(agents.id, f.agentId));
    await f.service.tick();
    expect(f.sends).toHaveLength(0);
    expect((await f.service.publication(queued.id, f.companyId)).outcome).toBe(
      "failed",
    );
  });

  it("enforces one inbox owner across companies and reconnects the same identity", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(
      db
        .update(chatEndpoints)
        .set({ botExternalId: f.address })
        .where(eq(chatEndpoints.id, other.endpointId)),
    ).rejects.toThrow();
    await f.receive(f.message());
    const before = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.endpointId, f.endpointId));
    const reconnected = await f.service.reconnect(
      f.endpointId,
      "replacement-test-key",
      "websocket",
      { userId: "email-board" },
    );
    expect(reconnected.address).toBe(f.address);
    expect(reconnected.receiveMode).toBe("websocket");
    expect(
      await db
        .select()
        .from(chatConversations)
        .where(eq(chatConversations.endpointId, f.endpointId)),
    ).toEqual(before);
  });

  it("keeps live receiving active when the key cannot register a webhook", async () => {
    const f = await fixture("websocket");
    f.setWebhookError(403);
    await expect(f.service.reconnect(f.endpointId, "replacement-test-key", "webhook", { userId: "email-board" }))
      .rejects.toThrow("Enable webhook create/read/delete permissions");
    expect(await f.service.getEndpoint(f.endpointId)).toMatchObject({ status: "active" });
    await f.receive(f.message());
    expect(f.wakeup).toHaveBeenCalledTimes(1);
  });

  it("saves a scoped credential before inbox setup, preserves personal ownership, and adds the chosen agent", async () => {
    const f = await fixture();
    const svc = emailConnectionService(db, f.fetcher);
    const actor = { userId: "email-board" };
    const input = {
      apiKey: "private-scoped-credential",
      grantKind: "user" as const,
      allAgents: false,
      agentIds: [],
      idempotencyKey: randomUUID(),
    };
    const concurrent = await Promise.all([
      svc.connect(f.companyId, input, actor),
      svc.connect(f.companyId, input, actor),
    ]);
    const connection = concurrent[0];
    expect(concurrent[1].id).toBe(connection.id);
    expect(JSON.stringify(connection)).not.toContain(input.apiKey);
    expect((await svc.connect(f.companyId, input, actor)).id).toBe(
      connection.id,
    );
    expect(
      (await svc.credential(f.companyId, connection.id, actor)).value,
    ).toBe(input.apiKey);
    const grants = await db
      .select()
      .from(connectionGrants)
      .where(eq(connectionGrants.connectionId, connection.id));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      kind: "user",
      subjectUserId: "email-board",
    });
    await expect(
      svc.credential(f.companyId, connection.id, { userId: "different-user" }),
    ).rejects.toThrow(/access/);
    await expect(
      svc.credential(randomUUID(), connection.id, actor),
    ).rejects.toThrow(/not found/);
    await f.service.control(f.endpointId, "remove", actor);
    // Credential permission alone must not install skills or tools.
    expect(await resolveConnectorAssignments(db, { companyId: f.companyId, agentId: f.agentId })).toEqual([]);
    const endpoint = await f.service.setup(
      f.companyId,
      {
        assignedAgentId: f.agentId,
        credentialConnectionId: connection.id,
        inboxId: f.address,
        receiveMode: "websocket",
        idempotencyKey: randomUUID(),
      },
      actor,
    );
    expect(endpoint.address).toBe(f.address);
    expect(await resolveConnectorAssignments(db, { companyId: f.companyId, agentId: f.agentId })).toHaveLength(1);
    const installs = await db
      .select()
      .from(toolConnectionInstalls)
      .where(eq(toolConnectionInstalls.connectionId, connection.id));
    expect(installs.some((i) => i.targetId === f.agentId)).toBe(true);
    await expect(
      svc.assertAgentAccess(f.companyId, connection.id, f.agentId),
    ).resolves.toBeUndefined();
    await db
      .delete(toolConnectionInstalls)
      .where(eq(toolConnectionInstalls.connectionId, connection.id));
    await expect(
      svc.assertAgentAccess(f.companyId, connection.id, f.agentId),
    ).rejects.toThrow(/no longer has access/);
    expect(await resolveConnectorAssignments(db, { companyId: f.companyId, agentId: f.agentId })).toEqual([]);
    await db
      .update(connectionGrants)
      .set({ status: "revoked" })
      .where(eq(connectionGrants.connectionId, connection.id));
    await expect(
      svc.credential(f.companyId, connection.id, actor),
    ).rejects.toThrow(/revoked/);
  });

  it("checks AgentMail account and inbox health without local stdio or MCP discovery", async () => {
    const f = await fixture();
    const connection = await emailConnectionService(db, f.fetcher).connect(f.companyId, {
      apiKey: "private-scoped-credential", grantKind: "user", allAgents: false,
      agentIds: [f.agentId], idempotencyKey: randomUUID(),
    }, { userId: "email-board" });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(f.fetcher);
    const tools = toolAccessService(db);
    const endpoint = await f.service.getEndpoint(f.endpointId);
    for (const id of [connection.id, endpoint.connectionId]) {
      const health = await tools.checkHealth(id);
      expect(health.connection.healthStatus).toBe("ok");
      expect(health.connection.healthMessage).toBe("AgentMail API key is connected.");
      expect(health.runtimeSlot).toBeNull();
      const catalog = await tools.refreshCatalog(id);
      expect(catalog.catalog).toEqual([]);
    }
    expect(fetcher.mock.calls.every(([url]) => String(url).endsWith("/auth/me"))).toBe(true);
    fetcher.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(tools.checkHealth(connection.id)).rejects.toThrow(/AgentMail request failed \(401\)/);
    expect((await tools.getConnection(connection.id, f.companyId))?.healthStatus).not.toBe("ok");
  });

  it("retries email tasks through normal recovery instead of restricted chat replay", async () => {
    const f = await fixture();
    await f.receive(f.message());
    const [task] = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, f.companyId));
    await db
      .update(issues)
      .set({ status: "blocked" })
      .where(eq(issues.id, task.id));
    const recovery = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId: f.companyId,
      sourceIssueId: task.id,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: f.agentId,
      cause: "issue_graph_liveness",
      fingerprint: "email:retry",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore execution",
      wakePolicy: { type: "manual" },
    });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "local_implicit" };
      next();
    });
    app.use(
      "/api",
      issueRoutes(db, {} as any, { recoveryActionEnqueueWakeup: enqueue }),
    );
    app.use(errorHandler);
    const result = await request(app)
      .post(`/api/issues/${task.id}/recovery-actions/resolve`)
      .send({
        actionId: recovery.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
      });
    expect(result.status).toBe(200);
    expect(result.body.issue.status).toBe("todo");
    expect(result.body.recoveryAction.status).toBe("resolved");
  });

  it("places inbound low-trust tasks inside their configured project and rejects unscoped setup", async () => {
    const f = await fixture();
    await db
      .update(agents)
      .set({ permissions: { trustPreset: "low_trust_review" } })
      .where(eq(agents.id, f.agentId));
    await expect(
      f.service.setup(
        f.companyId,
        {
          assignedAgentId: f.agentId,
          apiKey: "test-key",
          receiveMode: "websocket",
          idempotencyKey: randomUUID(),
        },
        { userId: "email-board" },
      ),
    ).rejects.toThrow(/boundary/);
    const [project] = await db
      .insert(projects)
      .values({ companyId: f.companyId, name: "Email work" })
      .returning();
    await db
      .update(agents)
      .set({
        permissions: {
          trustPreset: "low_trust_review",
          authorizationPolicy: {
            trustPreset: "low_trust_review",
            trustBoundary: {
              mode: "low_trust_review",
              companyId: f.companyId,
              projectIds: [project.id],
            },
          },
        },
      })
      .where(eq(agents.id, f.agentId));
    await expect(
      f.service.setup(
        f.companyId,
        {
          assignedAgentId: f.agentId,
          apiKey: "test-key",
          receiveMode: "websocket",
          idempotencyKey: randomUUID(),
        },
        { userId: "email-board" },
      ),
    ).rejects.toThrow(/sandbox environment/);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await f.receive(f.message());
    const [task] = await db
      .select()
      .from(issues)
      .where(eq(issues.companyId, f.companyId));
    expect(task.projectId).toBe(project.id);
    expect(task.executionWorkspaceSettings?.mode).toBe("isolated_workspace");
    await expect(
      f.service.authorizeRead(f.companyId, task.id, { agentId: f.agentId }),
    ).resolves.toBeUndefined();
    const outside = await issueService(db).create(f.companyId, {
      title: "Outside email scope",
      status: "backlog",
    });
    await expect(
      f.service.authorizeRead(f.companyId, outside.id, { agentId: f.agentId }),
    ).rejects.toThrow();
  });
});
