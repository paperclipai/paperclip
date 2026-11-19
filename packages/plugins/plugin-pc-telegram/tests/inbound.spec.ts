import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { DIALOG_ORIGIN_KIND, MAX_INBOUND_MEDIA_BYTES } from "../src/constants.js";
import { inboundShapeAllowed, ingestInboundMessage, shouldAcceptInbound, takePeerMediaSlot } from "../src/inbound.js";
import { collectInboundAttachments, readEventMessage, telegramPeerId } from "../src/telegram-gramjs.js";
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

  it("skips paused, group, and outgoing messages", () => {
    expect(shouldAcceptInbound({ ...connection, paused: true }, inboundMessage())).toBe(false);
    expect(shouldAcceptInbound(connection, inboundMessage({ isGroup: true, isPrivate: false }))).toBe(false);
    expect(shouldAcceptInbound(connection, inboundMessage({ isOutgoing: true }))).toBe(false);
  });
});
