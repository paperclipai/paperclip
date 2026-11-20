import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { DIALOG_ORIGIN_KIND } from "../src/constants.js";
import {
  INBOUND_COMPANY_QUOTA_BYTES,
  INBOUND_PEER_QUOTA_BYTES,
  admitInboundMedia,
  admitInboundMessage,
  inboundMediaAllowed,
  ingestInboundMessage,
  shouldAcceptInbound,
  shouldFetchInboundMedia,
} from "../src/inbound.js";
import manifest from "../src/manifest.js";
import { containsSecretMaterial } from "../src/redaction.js";
import { forwardFromStoredLine } from "../src/forward.js";
import { assembleInboundMessage } from "../src/telegram-gramjs.js";
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

  it("stores inbound voice bytes in plugin file storage, not the issue body", async () => {
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
    expect(issue?.description).toContain("attachment:");
    expect(issue?.description).not.toContain("AQIDBA==");
    const stored = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_ID,
      namespace: "inbound-files",
      stateKey: "voice-1",
    }) as { contentBase64?: string };
    expect(stored).toMatchObject({
      filename: "voice.ogg",
      mimeType: "audio/ogg",
      kind: "voice",
    });
    expect(stored.contentBase64).toBeUndefined();
  });

  it("persists the forward sender on the line the thread already parses", async () => {
    const harness = createTestHarness({ manifest });
    const issue = await ingestInboundMessage(harness.ctx, connection, inboundMessage({
      forward: { kind: "user", fromId: "9", fromName: "Ольга", authorName: null },
    }));
    expect(issue?.description).toContain("Переслано от **Ольга**");
    expect(forwardFromStoredLine("Переслано от **Ольга**")?.name).toBe("Ольга");
  });

  it("stops one peer at the peer cap and the next peer at the company cap", () => {
    const file = 4 * 1024 * 1024;
    const now = 1_700_000_000_000;
    let ledger: { entries: Array<{ peerId: string; bytes: number; at: number }>; messages: Array<{ peerId: string; at: number }> } = { entries: [], messages: [] };
    for (let index = 0; index < INBOUND_PEER_QUOTA_BYTES / file; index += 1) {
      const decision = admitInboundMedia(ledger, { peerId: "2002", bytes: file, now });
      expect(decision.ok).toBe(true);
      ledger = decision.ledger;
    }
    expect(admitInboundMedia(ledger, { peerId: "2002", bytes: file, now }).ok).toBe(false);
    const room = (INBOUND_COMPANY_QUOTA_BYTES - INBOUND_PEER_QUOTA_BYTES) / file;
    for (let index = 0; index < room; index += 1) {
      const decision = admitInboundMedia(ledger, { peerId: "3003", bytes: file, now });
      expect(decision.ok).toBe(true);
      ledger = decision.ledger;
    }
    expect(admitInboundMedia(ledger, { peerId: "3003", bytes: file, now }).ok).toBe(false);
  });

  it("does not store another copy when the peer quota is already full", async () => {
    const harness = createTestHarness({ manifest });
    await harness.ctx.state.set({
      scopeKind: "company",
      scopeId: COMPANY_ID,
      namespace: "inbound-quota",
      stateKey: "usage",
    }, {
      entries: [{ peerId: "2002", bytes: INBOUND_PEER_QUOTA_BYTES, at: Date.now() }],
    });
    const issue = await ingestInboundMessage(harness.ctx, connection, inboundMessage({
      text: "see attached",
      attachments: [{
        id: "photo-1",
        filename: "shot.jpg",
        mimeType: "image/jpeg",
        byteLength: 100,
        kind: "photo",
        bytes: new Uint8Array(100),
      }],
    }));
    expect(issue?.description).toContain("storage quota");
    expect(issue?.description).not.toContain("shot.jpg");
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_ID,
      namespace: "inbound-files",
      stateKey: "photo-1",
    })).toBeUndefined();
  });

  it("does not download media the connection will reject", async () => {
    const downloadMedia = vi.fn(async () => Buffer.from("nope"));
    expect(shouldFetchInboundMedia({ ...connection, paused: true }, inboundMessage({ text: "", attachments: [] }))).toBe(false);
    expect(shouldFetchInboundMedia(connection, inboundMessage({ text: "", attachments: [] }))).toBe(true);
    const skipped = await assembleInboundMessage({
      isPrivate: true,
      id: 5,
      message: "",
      sender: { id: 2002, firstName: "Sam" },
      media: { className: "MessageMediaDocument", size: 4 },
      downloadMedia,
    }, {
      companyId: COMPANY_ID,
      accountId: "1001",
      allowMedia: async () => false,
    });
    expect(skipped).toBeNull();
    expect(downloadMedia).not.toHaveBeenCalled();
    const caption = await assembleInboundMessage({
      isPrivate: true,
      id: 6,
      message: "please check this screenshot",
      sender: { id: 2002, firstName: "Sam" },
      media: { className: "MessageMediaDocument", size: 4 },
      downloadMedia,
    }, {
      companyId: COMPANY_ID,
      accountId: "1001",
      allowMedia: async () => false,
    });
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(caption?.attachments).toEqual([]);
    expect(caption?.mediaSkipped).toBe(true);
    const bot = await assembleInboundMessage({
      isPrivate: true,
      id: 7,
      message: "I am a bot",
      sender: { id: 2002, firstName: "Sam", bot: true },
      media: { className: "MessageMediaDocument", size: 4 },
      downloadMedia,
    }, {
      companyId: COMPANY_ID,
      accountId: "1001",
      allowMedia: async () => true,
    });
    expect(bot).toBeNull();
    const mismatch = await assembleInboundMessage({
      isPrivate: true,
      id: 8,
      message: "other person",
      peerId: 2002,
      sender: { id: 9, firstName: "Other" },
      media: { className: "MessageMediaDocument", size: 4 },
      downloadMedia,
    }, {
      companyId: COMPANY_ID,
      accountId: "1001",
      allowMedia: async () => true,
    });
    expect(mismatch).toBeNull();
    expect(downloadMedia).not.toHaveBeenCalled();
    const harness = createTestHarness({ manifest });
    const issue = await ingestInboundMessage(harness.ctx, connection, caption!);
    expect(issue?.description).toContain("please check this screenshot");
    expect(issue?.description).toContain("storage quota");
    expect(issue?.description).not.toContain("base64");
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

  it("drops a bot, a mismatched sender, an unlisted peer, and a non-user id", async () => {
    const harness = createTestHarness({ manifest });
    const closed = { ...connection, acceptUnlistedSenders: false, allowedPeerIds: [] };
    expect(await ingestInboundMessage(harness.ctx, closed, inboundMessage())).toBeNull();
    const listed = await ingestInboundMessage(
      harness.ctx,
      { ...closed, allowedPeerIds: ["2002"] },
      inboundMessage(),
    );
    expect(listed?.originId).toBe("1001:2002");
    expect(await ingestInboundMessage(harness.ctx, connection, inboundMessage({ senderBot: true }))).toBeNull();
    expect(await ingestInboundMessage(harness.ctx, connection, inboundMessage({ senderId: "9" }))).toBeNull();
    expect(await ingestInboundMessage(harness.ctx, connection, inboundMessage({ peerId: "abc" }))).toBeNull();
    const issues = await harness.ctx.issues.list({ companyId: COMPANY_ID, originKind: DIALOG_ORIGIN_KIND });
    expect(issues).toHaveLength(1);
  });

  it("keeps the message count when a file is admitted", () => {
    const now = 1_700_000_000_000;
    const withMessage = admitInboundMessage({ entries: [], messages: [] }, { peerId: "2002", now });
    const withFile = admitInboundMedia(withMessage.ledger, { peerId: "2002", bytes: 10, now });
    expect(withFile.ok).toBe(true);
    expect(withFile.ledger.messages).toEqual([{ peerId: "2002", at: now }]);
  });

  it("stops the 21st message in the same minute before a comment", async () => {
    const now = 1_700_000_000_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const harness = createTestHarness({ manifest });
      const first = await ingestInboundMessage(harness.ctx, connection, inboundMessage({ messageId: "1" }));
      expect(first).not.toBeNull();
      for (let index = 2; index <= 20; index += 1) {
        const issue = await ingestInboundMessage(
          harness.ctx,
          connection,
          inboundMessage({ messageId: String(index), text: `m${index}` }),
        );
        expect(issue?.id).toBe(first?.id);
      }
      const comments = await harness.ctx.issues.listComments(first!.id, COMPANY_ID);
      expect(comments).toHaveLength(19);
      expect(await ingestInboundMessage(
        harness.ctx,
        connection,
        inboundMessage({ messageId: "21", text: "too many" }),
      )).toBeNull();
      const after = await harness.ctx.issues.listComments(first!.id, COMPANY_ID);
      expect(after).toHaveLength(19);
      expect(after.some((comment) => comment.body.includes("too many"))).toBe(false);
      const stored = harness.getState({
        scopeKind: "company",
        scopeId: COMPANY_ID,
        namespace: "inbound-quota",
        stateKey: "usage",
      }) as { messages?: unknown[] };
      expect(stored.messages).toHaveLength(20);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not download media when the message cap is already full", async () => {
    const harness = createTestHarness({ manifest });
    const now = Date.now();
    await harness.ctx.state.set({
      scopeKind: "company",
      scopeId: COMPANY_ID,
      namespace: "inbound-quota",
      stateKey: "usage",
    }, {
      entries: [],
      messages: Array.from({ length: 20 }, () => ({ peerId: "2002", at: now })),
    });
    const downloadMedia = vi.fn(async () => Buffer.from("nope"));
    const message = await assembleInboundMessage({
      isPrivate: true,
      id: 9,
      message: "again",
      sender: { id: 2002, firstName: "Sam" },
      media: { className: "MessageMediaDocument", size: 4 },
      downloadMedia,
    }, {
      companyId: COMPANY_ID,
      accountId: "1001",
      allowMedia: ({ peerId, declaredBytes }) => inboundMediaAllowed(harness.ctx, connection, peerId, declaredBytes),
    });
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(message?.text).toBe("again");
    expect(message?.mediaSkipped).toBe(true);
    expect(message?.attachments).toEqual([]);
  });
});
