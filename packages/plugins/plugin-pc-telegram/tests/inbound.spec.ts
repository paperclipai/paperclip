import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { CONNECTION_LIFETIME_MESSAGES, CONNECTION_WINDOW_BYTES, CONNECTION_WINDOW_MESSAGES, DIALOG_ORIGIN_KIND, INBOUND_QUOTA_DAY_MS, MAX_INBOUND_MEDIA_BYTES } from "../src/constants.js";
import {
  commitInboundUsage,
  inboundQuotaKeyCount,
  inboundShapeAllowed,
  ingestInboundMessage,
  shouldAcceptInbound,
  takeInboundMessageSlot,
  takeNewPeerSlot,
  takePeerMediaSlot,
} from "../src/inbound.js";
import { collectInboundAttachments, directUserPeerId, readEventMessage, telegramPeerId } from "../src/telegram-gramjs.js";
import manifest from "../src/manifest.js";
import { containsSecretMaterial } from "../src/redaction.js";
import {
  AGENT_ID,
  COMPANY_ID,
  MOCK_SESSION,
  inboundMessage,
} from "./support.js";
import type { TelegramConnection } from "../src/types.js";

const connection: TelegramConnection = {
  companyId: COMPANY_ID,
  telegramUserId: "1001",
  username: "desk",
  displayName: "Front Desk",
  assignedAgentId: AGENT_ID,
  incomingMode: "dialog_task",
  paused: false,
  acceptUnlistedSenders: true,
  allowedPeerIds: [],
  sessionSecretId: "secret-1",
  live: true,
};

describe("inbound issue mapping", () => {
  it("creates a dialog issue assigned to the connection agent", async () => {
    const harness = createTestHarness({ manifest });
    const issue = await ingestInboundMessage(harness.ctx, connection, inboundMessage());
    expect(issue).toMatchObject({
      companyId: COMPANY_ID,
      assigneeAgentId: AGENT_ID,
      originKind: DIALOG_ORIGIN_KIND,
      originId: "1001:2002",
      title: "Telegram · Sam",
    });
    expect(issue?.description).toContain("Need a quote");
    expect(containsSecretMaterial(issue, [MOCK_SESSION])).toBe(false);
  });

  it("continues the same dialog issue and reassigns the current agent", async () => {
    const harness = createTestHarness({ manifest });
    const first = await ingestInboundMessage(harness.ctx, connection, inboundMessage());
    const second = await ingestInboundMessage(
      harness.ctx,
      { ...connection, assignedAgentId: "55555555-5555-4555-8555-555555555555" },
      inboundMessage({ messageId: "2", text: "Follow up" }),
    );
    expect(second?.id).toBe(first?.id);
    expect(second?.assigneeAgentId).toBe("55555555-5555-4555-8555-555555555555");
    const comments = await harness.ctx.issues.listComments(second!.id, COMPANY_ID);
    expect(comments.some((comment) => comment.body.includes("Follow up"))).toBe(true);
    expect(containsSecretMaterial(comments, [MOCK_SESSION])).toBe(false);
  });

  it("links inbound voice without keeping the bytes in plugin state", async () => {
    const harness = createTestHarness({ manifest });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const issue = await ingestInboundMessage(harness.ctx, connection, inboundMessage({
      text: "",
      attachments: [{
        id: "voice-1",
        filename: "voice.ogg",
        mimeType: "audio/ogg",
        byteLength: bytes.byteLength,
        kind: "voice",
        bytes,
      }],
    }));
    expect(issue?.description).toContain("Voice message: voice.ogg");
    expect(issue?.description).toContain("[Voice message: voice.ogg](/api/attachments/");
    expect(issue?.description).toContain("/content)");
    expect(issue?.description).not.toContain("AQIDBA==");
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_ID,
      namespace: "inbound-files",
      stateKey: "voice-1",
    })).toBeUndefined();
  });

  it("keeps the dialog text when an attachment is rejected", async () => {
    const harness = createTestHarness({ manifest });
    let wakeups = 0;
    const wake = harness.ctx.issues.requestWakeup.bind(harness.ctx.issues);
    harness.ctx.issues.requestWakeup = async (...args) => {
      wakeups += 1;
      return wake(...args);
    };
    harness.ctx.issues.createAttachment = async () => {
      throw new Error("Attachment exceeds 4194304 bytes");
    };
    const bytes = new Uint8Array([9, 9, 9]);
    const issue = await ingestInboundMessage(harness.ctx, connection, inboundMessage({
      text: "Need a quote",
      attachments: [{
        id: "clip-1",
        filename: "clip.bin",
        mimeType: "application/octet-stream",
        byteLength: bytes.byteLength,
        kind: "file",
        bytes,
      }],
    }));
    expect(issue?.description).toContain("Need a quote");
    expect(issue?.description).toContain("Could not attach");
    expect(issue?.description).toContain("clip.bin");
    expect(issue?.description).toContain("Attachment exceeds 4194304 bytes");
    expect(issue?.description).not.toContain("[Attachment: clip.bin](");
    expect(wakeups).toBe(1);
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_ID,
      namespace: "inbound-files",
      stateKey: "clip-1",
    })).toBeUndefined();
  });

  it("drops media above the byte cap before creating an attachment", async () => {
    const harness = createTestHarness({ manifest });
    let created = 0;
    harness.ctx.issues.createAttachment = async () => {
      created += 1;
      throw new Error("should not attach");
    };
    const issue = await ingestInboundMessage(harness.ctx, connection, inboundMessage({
      text: "Need a quote",
      attachments: [{
        id: "huge",
        filename: "huge.bin",
        mimeType: "application/octet-stream",
        byteLength: MAX_INBOUND_MEDIA_BYTES + 1,
        kind: "file",
        bytes: new Uint8Array([1]),
      }],
    }));
    expect(created).toBe(0);
    expect(issue?.description).toContain("Need a quote");
    expect(issue?.description).not.toContain("huge.bin");
  });

  it("allows empty text when the chat shape is acceptable", () => {
    expect(inboundShapeAllowed(connection, inboundMessage({ text: "", attachments: [] }))).toBe(true);
    expect(shouldAcceptInbound(connection, inboundMessage({ text: "", attachments: [] }))).toBe(false);
    expect(inboundShapeAllowed({ ...connection, paused: true }, inboundMessage())).toBe(false);
  });

  it("limits media downloads per peer", () => {
    const peerKey = "company:account:slot-peer";
    const now = 5_000_000;
    for (let index = 0; index < 8; index += 1) {
      expect(takePeerMediaSlot(peerKey, now)).toBe(true);
    }
    expect(takePeerMediaSlot(peerKey, now)).toBe(false);
    expect(takePeerMediaSlot(peerKey, now + 60_000)).toBe(true);
  });

  it("stops a peer after a day of media even when each minute stays inside the short window", () => {
    const peerKey = "company:account:day-peer";
    const start = 10_000_000;
    for (let bucket = 0; bucket < 5; bucket += 1) {
      const at = start + bucket * 60_000;
      for (let index = 0; index < 8; index += 1) {
        expect(takePeerMediaSlot(peerKey, at)).toBe(true);
      }
    }
    expect(takePeerMediaSlot(peerKey, start + 5 * 60_000)).toBe(false);
    expect(takePeerMediaSlot(peerKey, start + 24 * 60 * 60 * 1000)).toBe(true);
  });

  it("caps text messages per peer and new conversations per company", () => {
    const peerKey = "company:account:text-peer";
    const now = 20_000_000;
    for (let index = 0; index < 20; index += 1) {
      expect(takeInboundMessageSlot(peerKey, now)).toBe(true);
    }
    expect(takeInboundMessageSlot(peerKey, now)).toBe(false);
    expect(takeInboundMessageSlot(peerKey, now + 60_000)).toBe(true);
    const companyId = "company-new-peers";
    for (let index = 0; index < 30; index += 1) {
      expect(takeNewPeerSlot(companyId, now)).toBe(true);
    }
    expect(takeNewPeerSlot(companyId, now)).toBe(false);
    expect(takeNewPeerSlot(companyId, now + 60 * 60 * 1000)).toBe(true);
    const dayKey = "company:account:text-day";
    const dayStart = 30_000_000;
    for (let index = 0; index < 200; index += 1) {
      expect(takeInboundMessageSlot(dayKey, dayStart + index * 60_000)).toBe(true);
    }
    expect(takeInboundMessageSlot(dayKey, dayStart + 200 * 60_000)).toBe(false);
  });

  it("keeps GramJS getters and reads a PeerUser id", () => {
    class GramMessage {
      id = 9;
      message = "hello";
      get isPrivate() { return true; }
      get out() { return false; }
      get peerId() { return { userId: 2002 }; }
      get sender() { return { firstName: "Sam" }; }
      downloadMedia() { return Promise.resolve(Buffer.from([1])); }
    }
    const message = readEventMessage({ message: new GramMessage() });
    expect(message?.isPrivate).toBe(true);
    expect(message?.sender?.firstName).toBe("Sam");
    expect(typeof message?.downloadMedia).toBe("function");
    expect(telegramPeerId(message?.sender, message?.peerId)).toBe("2002");
    expect(directUserPeerId(message?.sender, message?.peerId)).toBe("2002");
    expect(directUserPeerId({ id: 2002, bot: true }, { userId: 2002 })).toBeNull();
    expect(directUserPeerId({ id: 9 }, { userId: 2002 })).toBeNull();
    expect(directUserPeerId({ id: 2002 }, { channelId: 9 })).toBeNull();
    expect(directUserPeerId(null, { channelId: 9 })).toBeNull();
    expect(MAX_INBOUND_MEDIA_BYTES).toBe(4 * 1024 * 1024);
  });

  it("does not download media whose declared size is over the cap", async () => {
    let downloads = 0;
    const attachments = await collectInboundAttachments({
      id: 1,
      media: {
        className: "MessageMediaDocument",
        document: { size: MAX_INBOUND_MEDIA_BYTES + 1 },
        mimeType: "application/octet-stream",
      },
      downloadMedia: async () => {
        downloads += 1;
        return Buffer.from("nope");
      },
    });
    expect(downloads).toBe(0);
    expect(attachments).toEqual([]);
  });

  it("drops a downloaded buffer that is still over the cap", async () => {
    const attachments = await collectInboundAttachments({
      id: 3,
      media: { className: "MessageMediaPhoto", photo: { sizes: [{ size: 32 }, { size: 128 }] } },
      downloadMedia: async () => Buffer.alloc(MAX_INBOUND_MEDIA_BYTES + 1),
    });
    expect(attachments).toEqual([]);
  });

  it("stops a download once the received byte count passes the cap", async () => {
    await expect(collectInboundAttachments({
      id: 2,
      media: { className: "MessageMediaDocument", mimeType: "application/octet-stream" },
      downloadMedia: async (params) => {
        params?.progressCallback?.(MAX_INBOUND_MEDIA_BYTES + 1, MAX_INBOUND_MEDIA_BYTES + 1);
        return Buffer.from("late");
      },
    })).rejects.toThrow(/attachment limit/);
  });

  it("reopens a completed dialog before waking the assigned agent", async () => {
    const harness = createTestHarness({ manifest });
    const first = await ingestInboundMessage(harness.ctx, connection, inboundMessage());
    await harness.ctx.issues.update(first!.id, { status: "done" }, COMPANY_ID);
    const second = await ingestInboundMessage(
      harness.ctx,
      connection,
      inboundMessage({ messageId: "2", text: "Still here" }),
    );
    expect(second?.id).toBe(first?.id);
    expect(second?.status).toBe("todo");
  });

  it("creates one dialog when two messages for the same chat arrive together", async () => {
    const harness = createTestHarness({ manifest });
    const [first, second] = await Promise.all([
      ingestInboundMessage(harness.ctx, connection, inboundMessage({ messageId: "1", text: "One" })),
      ingestInboundMessage(harness.ctx, connection, inboundMessage({ messageId: "2", text: "Two" })),
    ]);
    expect(second?.id).toBe(first?.id);
    const issues = await harness.ctx.issues.list({
      companyId: COMPANY_ID,
      originKind: DIALOG_ORIGIN_KIND,
      originId: "1001:2002",
    });
    expect(issues).toHaveLength(1);
  });

  it("drops an unlisted sender until the board allows that user", async () => {
    const harness = createTestHarness({ manifest });
    const closed = { ...connection, acceptUnlistedSenders: false, allowedPeerIds: [] as string[] };
    expect(await ingestInboundMessage(harness.ctx, closed, inboundMessage())).toBeNull();
    const listed = { ...closed, allowedPeerIds: ["2002"] };
    expect((await ingestInboundMessage(harness.ctx, listed, inboundMessage()))?.originId).toBe("1001:2002");
    expect(await ingestInboundMessage(
      harness.ctx,
      listed,
      inboundMessage({ peerId: "9999", messageId: "9", text: "Other person" }),
    )).toBeNull();
  });

  it("stops persisting once the company byte quota is full", async () => {
    const harness = createTestHarness({ manifest });
    const second = { ...connection, telegramUserId: "1002" };
    const third = { ...connection, telegramUserId: "1003" };
    expect(await commitInboundUsage(harness.ctx, connection, {
      messages: 0,
      attachments: 0,
      bytes: CONNECTION_WINDOW_BYTES,
    })).toBe(true);
    expect(await commitInboundUsage(harness.ctx, second, {
      messages: 0,
      attachments: 0,
      bytes: CONNECTION_WINDOW_BYTES,
    })).toBe(true);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(await ingestInboundMessage(harness.ctx, third, inboundMessage({
      accountId: "1003",
      text: "over the company quota",
      attachments: [{
        id: "over",
        filename: "a.bin",
        mimeType: "application/octet-stream",
        byteLength: bytes.byteLength,
        kind: "file",
        bytes,
      }],
    }))).toBeNull();
  });

  it("fails closed when the quota ledger cannot be read", async () => {
    const harness = createTestHarness({ manifest });
    harness.ctx.state.get = async () => {
      throw new Error("state down");
    };
    expect(await ingestInboundMessage(harness.ctx, connection, inboundMessage())).toBeNull();
  });

  it("keeps an account lifetime cap after that account is idle for a day", async () => {
    const harness = createTestHarness({ manifest });
    const second = { ...connection, telegramUserId: "1002" };
    let now = Date.UTC(2026, 0, 1);
    const days = CONNECTION_LIFETIME_MESSAGES / CONNECTION_WINDOW_MESSAGES;
    for (let day = 0; day < days; day += 1) {
      expect(await commitInboundUsage(harness.ctx, connection, {
        messages: CONNECTION_WINDOW_MESSAGES,
        attachments: 0,
        bytes: 0,
      }, now)).toBe(true);
      now += INBOUND_QUOTA_DAY_MS + 3_600_000;
    }
    expect(await commitInboundUsage(harness.ctx, connection, {
      messages: 1,
      attachments: 0,
      bytes: 0,
    }, now)).toBe(false);
    expect(await commitInboundUsage(harness.ctx, second, {
      messages: 1,
      attachments: 0,
      bytes: 0,
    }, now)).toBe(true);
    expect(await commitInboundUsage(harness.ctx, connection, {
      messages: 1,
      attachments: 0,
      bytes: 0,
    }, now)).toBe(false);
  });

  it("drops expired inbound quota keys", () => {
    const now = Date.now() + INBOUND_QUOTA_DAY_MS;
    takePeerMediaSlot("stale-peer-sweep", now - INBOUND_QUOTA_DAY_MS - 1);
    expect(inboundQuotaKeyCount()).toBeGreaterThan(0);
    takeInboundMessageSlot("fresh-peer-sweep", now);
    expect(inboundQuotaKeyCount()).toBe(2);
  });

  it("skips paused, group, and outgoing messages", () => {
    expect(shouldAcceptInbound({ ...connection, paused: true }, inboundMessage())).toBe(false);
    expect(shouldAcceptInbound(connection, inboundMessage({ isGroup: true, isPrivate: false }))).toBe(false);
    expect(shouldAcceptInbound(connection, inboundMessage({ isOutgoing: true }))).toBe(false);
  });
});
