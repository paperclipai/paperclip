import { describe, expect, it, vi } from "vitest";
import { normalizeTelegramVideoNoteAttachments } from "./chat-telegram-video-note.js";
import { createChatSdkEndpointRuntime } from "./chat-sdk-runtime.js";
import type { Attachment } from "chat";

function fixture() {
  const raw = {
    message_id: 41,
    date: 1_788_900_000,
    chat: { id: 77115569, type: "private" },
    from: { id: 77115569, is_bot: false, first_name: "Fixture" },
    video_note: {
      file_id: "note-id",
      file_unique_id: "note-unique",
      length: 16,
      duration: 1,
      file_size: 1024,
    },
  };
  const attachment: Attachment = {
    type: "video",
    width: 16,
    height: 16,
    size: 1024,
    fetchMetadata: { fileId: "note-id", fileUniqueId: "note-unique" },
    fetchData: vi.fn(async () => Buffer.alloc(0)),
  };
  return { raw, attachment };
}

describe("Telegram video-note MIME contract", () => {
  it("fills only the exact parser-bound note MIME while preserving all download metadata", () => {
    const { raw, attachment } = fixture();
    expect(normalizeTelegramVideoNoteAttachments(raw, [attachment])).toEqual([
      { ...attachment, mimeType: "video/mp4" },
    ]);
    expect(attachment.mimeType).toBeUndefined();
    expect(attachment.fetchData).not.toHaveBeenCalled();
  });

  it.each<{
    label: string;
    source?: Record<string, unknown>;
    note?: Record<string, unknown>;
  }>([
    { label: "missing video-note", source: { video_note: undefined } },
    {
      label: "ordinary document with claimed type",
      source: {
        document: { file_id: "note-id", mime_type: "application/octet-stream" },
      },
    },
    { label: "missing source message", source: { message_id: undefined } },
    { label: "invalid source chat", source: { chat: { id: 0 } } },
    { label: "missing file id", note: { file_id: undefined } },
    { label: "control-character file id", note: { file_id: "note-id\n" } },
    { label: "missing unique id", note: { file_unique_id: undefined } },
    { label: "invalid geometry", note: { length: -1 } },
    { label: "invalid duration", note: { duration: NaN } },
    { label: "invalid byte size", note: { file_size: "1024" } },
  ])("does not infer MIME for $label", ({ source, note }) => {
    const { raw, attachment } = fixture();
    const input = [attachment];
    expect(
      normalizeTelegramVideoNoteAttachments(
        { ...raw, video_note: { ...raw.video_note, ...note }, ...source },
        input,
      ),
    ).toBe(input);
  });

  it.each([
    { type: "file" as const },
    { mimeType: "application/octet-stream" },
    { mimeType: "application/x-msdownload" },
    { fetchMetadata: { fileId: "other-id", fileUniqueId: "note-unique" } },
    { fetchMetadata: { fileId: "note-id", fileUniqueId: "other-unique" } },
    { width: 17 },
    { height: 17 },
    { size: 1025 },
  ])(
    "does not borrow raw-source authority for mismatched attachment %j",
    (patch) => {
      const { raw, attachment } = fixture();
      const input = [{ ...attachment, ...patch }];
      expect(normalizeTelegramVideoNoteAttachments(raw, input)).toBe(input);
    },
  );

  it("does not normalize a mixed attachment list", () => {
    const { raw, attachment } = fixture();
    const input = [attachment, { ...attachment }];
    expect(normalizeTelegramVideoNoteAttachments(raw, input)).toBe(input);
  });

  it("preserves normalization and exact download identity in the real pinned restart descriptor", async () => {
    const runtime = createChatSdkEndpointRuntime({
      companyId: "video-note-company",
      endpointId: "video-note-endpoint",
      logger: "silent",
      callbacks: { onMessage() {} },
      persistence: {
        async read() {
          return null;
        },
        async compareAndSet() {
          return true;
        },
        async deleteIfVersion() {
          return true;
        },
      },
      providerConfig: {
        provider: "telegram",
        userName: "fixture_bot",
        credentials: { botToken: "123:synthetic", secretToken: "synthetic" },
      },
    });
    try {
      const { raw } = fixture();
      const message = runtime.parseTelegramCommandMessage(raw)!;
      expect(message.attachments[0]).toMatchObject({
        type: "video",
        mimeType: "video/mp4",
      });
      const descriptor = runtime.attachmentRecoveryDescriptor(
        message.attachments[0]!,
      );
      expect(descriptor).toEqual({
        version: 1,
        provider: "telegram",
        attachment: {
          type: "video",
          mimeType: "video/mp4",
          size: 1024,
          width: 16,
          height: 16,
        },
        locator: {
          kind: "telegram_file_id",
          fileId: "note-id",
          fileUniqueId: "note-unique",
        },
      });
      expect(
        runtime.rehydrateAttachment(JSON.parse(JSON.stringify(descriptor)), {
          threadId: message.threadId,
          messageId: message.id,
        }),
      ).toMatchObject({
        type: "video",
        mimeType: "video/mp4",
        fetchMetadata: { fileId: "note-id", fileUniqueId: "note-unique" },
        fetchData: expect.any(Function),
      });
      expect(
        runtime.rehydrateAttachment({ ...descriptor, provider: "slack" }),
      ).toBeNull();
    } finally {
      await runtime.shutdown();
    }
  });

  it("only dispatches a normalized note after the real webhook secret check", async () => {
    const onMessage = vi.fn();
    const providerCalls: string[] = [];
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        const method = url.pathname.split("/").at(-1)!;
        providerCalls.push(method);
        if (url.hostname !== "api.telegram.org")
          throw new Error("Unexpected fixture provider host");
        if (method === "getMe")
          return Response.json({
            ok: true,
            result: {
              id: 123,
              is_bot: true,
              first_name: "Fixture bot",
              username: "fixture_bot",
            },
          });
        if (method === "getChat")
          return Response.json({
            ok: true,
            result: { id: 77115569, type: "private", first_name: "Fixture" },
          });
        if (method === "sendChatAction")
          return Response.json({ ok: true, result: true });
        throw new Error("Unexpected fixture provider method");
      });
    const runtime = createChatSdkEndpointRuntime({
      companyId: "video-note-company",
      endpointId: "video-note-endpoint",
      logger: "silent",
      callbacks: { onMessage },
      persistence: {
        async read() {
          return null;
        },
        async compareAndSet() {
          return true;
        },
        async deleteIfVersion() {
          return true;
        },
      },
      providerConfig: {
        provider: "telegram",
        userName: "fixture_bot",
        credentials: {
          botToken: "123:synthetic",
          secretToken: "synthetic-secret",
        },
      },
    });
    try {
      await runtime.initialize();
      const { raw } = fixture();
      const request = (secret: string) =>
        new Request("https://paperclip.test/telegram", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": secret,
          },
          body: JSON.stringify({ update_id: 71, message: raw }),
        });
      expect(
        (await runtime.handleWebhook(request("wrong-secret"))).status,
      ).toBe(401);
      expect(onMessage).not.toHaveBeenCalled();
      expect(
        (await runtime.handleWebhook(request("synthetic-secret"))).status,
      ).toBe(200);
      expect(onMessage).toHaveBeenCalledOnce();
      expect(onMessage.mock.calls[0]![0]).toMatchObject({
        endpointId: "video-note-endpoint",
        provider: "telegram",
        providerUpdateId: 71,
        message: {
          id: "77115569:41",
          threadId: "telegram:77115569",
          attachments: [
            {
              mimeType: "video/mp4",
              fetchMetadata: { fileId: "note-id", fileUniqueId: "note-unique" },
            },
          ],
        },
      });
      expect(providerCalls).not.toContain("getFile");
    } finally {
      try {
        await runtime.shutdown();
      } finally {
        providerFetch.mockRestore();
      }
    }
  });
});
