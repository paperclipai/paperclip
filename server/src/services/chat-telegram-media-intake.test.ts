import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createChatSdkEndpointRuntime } from "./chat-sdk-runtime.js";
import {
  hasTelegramMediaProvenance,
  identifyTelegramMedia,
} from "./chat-telegram-media-intake.js";
import { TELEGRAM_VIDEO_NOTE_MP4 } from "../__tests__/fixtures/telegram-video-note.js";
import {
  TELEGRAM_AUDIO_MP3,
  TELEGRAM_AUDIO_MP4,
  TELEGRAM_VOICE_OGG,
} from "../__tests__/fixtures/telegram-voice.js";

const options = {
  callbacks: { onMessage() {} },
  companyId: "fixture-company",
  endpointId: "fixture-endpoint",
  logger: "silent" as const,
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
    provider: "telegram" as const,
    userName: "fixture_bot",
    credentials: { botToken: "1:synthetic", secretToken: "synthetic" },
  },
};
const scope = {
  threadId: "telegram:-10077:42",
  messageId: "-10077:50",
  principalExternalId: "77",
  runtimeGeneration: 3,
  credentialFingerprint: "fixture-fingerprint",
};
function raw(kind: string, bytes: Buffer, extra: Record<string, unknown> = {}) {
  return {
    message_id: 50,
    date: 1_788_700_000,
    message_thread_id: 42,
    chat: { id: -10077, type: "supergroup" },
    from: { id: 77, is_bot: false, first_name: "Fixture" },
    [kind]: {
      file_id: "exact-file",
      file_unique_id: "exact-unique",
      file_size: bytes.length,
      duration: 1,
      ...(["video", "animation", "live_photo"].includes(kind)
        ? { width: 16, height: 16 }
        : {}),
      ...extra,
    },
  };
}

describe("Telegram source-bound optional media identification", () => {
  it.each([
    ["voice", TELEGRAM_VOICE_OGG, "audio/ogg"],
    ["voice", TELEGRAM_AUDIO_MP3, "audio/mpeg"],
    ["audio", TELEGRAM_AUDIO_MP4, "audio/mp4"],
    ["video", TELEGRAM_VIDEO_NOTE_MP4, "video/mp4"],
    ["animation", TELEGRAM_VIDEO_NOTE_MP4, "video/mp4"],
  ] as const)(
    "identifies valid %s bytes and restores exact source provenance",
    async (kind, bytes, expected) => {
      const runtime = createChatSdkEndpointRuntime(options);
      const fresh = createChatSdkEndpointRuntime(options);
      try {
        const attachment = runtime.parseTelegramCommandMessage(
          raw(kind, bytes),
        )!.attachments[0]!;
        expect(attachment.mimeType).toBeUndefined();
        expect(identifyTelegramMedia(attachment, bytes)).toBe(expected);
        const descriptor = runtime.attachmentRecoveryDescriptor(
          attachment,
          scope,
        )!;
        expect(descriptor.locator.kind).toBe("telegram_media");
        expect(JSON.stringify(descriptor)).not.toMatch(
          /synthetic|botToken|https?:/,
        );
        const restored = fresh.rehydrateAttachment(
          JSON.parse(JSON.stringify(descriptor)),
          scope,
        )!;
        expect(restored.fetchMetadata).toEqual({
          fileId: "exact-file",
          fileUniqueId: "exact-unique",
        });
        expect(identifyTelegramMedia(restored, bytes)).toBe(expected);
        expect(
          runtime.attachmentRecoveryDescriptor({ ...attachment }, scope)
            ?.locator.kind,
        ).not.toBe("telegram_media");
      } finally {
        await runtime.shutdown();
        await fresh.shutdown();
      }
    },
  );

  it("extracts a Live Photo's independent JPEG and MP4 and identifies a GIF animation", async () => {
    const runtime = createChatSdkEndpointRuntime(options);
    try {
      const gif = await sharp({
        create: { width: 16, height: 16, channels: 3, background: "teal" },
      })
        .gif()
        .toBuffer();
      const animation = runtime.parseTelegramCommandMessage(
        raw("animation", gif),
      )!.attachments[0]!;
      expect(identifyTelegramMedia(animation, gif)).toBe("image/gif");
      const message = runtime.parseTelegramCommandMessage(
        raw("live_photo", TELEGRAM_VIDEO_NOTE_MP4, {
          photo: [
            {
              file_id: "static-photo",
              file_unique_id: "static-unique",
              width: 16,
              height: 16,
              file_size: 123,
            },
          ],
        }),
      )!;
      expect(message.attachments).toHaveLength(2);
      expect(message.attachments[0]).toMatchObject({
        type: "image",
        mimeType: "image/jpeg",
      });
      expect(
        identifyTelegramMedia(message.attachments[1]!, TELEGRAM_VIDEO_NOTE_MP4),
      ).toBe("video/mp4");
      expect(
        message.attachments.map(
          (a) => runtime.attachmentRecoveryDescriptor(a, scope)?.locator,
        ),
      ).toEqual([
        expect.objectContaining({
          fileId: "static-photo",
          media: "live_photo_image",
        }),
        expect.objectContaining({
          fileId: "exact-file",
          media: "live_photo_video",
        }),
      ]);
    } finally {
      await runtime.shutdown();
    }
  });

  it.each([
    "messageId",
    "threadId",
    "principalExternalId",
    "runtimeGeneration",
    "credentialFingerprint",
    "fileId",
    "fileUniqueId",
    "metadataSha256",
    "endpointId",
    "companyId",
  ])("refuses changed durable %s binding", async (field) => {
    const runtime = createChatSdkEndpointRuntime(options);
    try {
      const attachment = runtime.parseTelegramCommandMessage(
        raw("video", TELEGRAM_VIDEO_NOTE_MP4),
      )!.attachments[0]!;
      const descriptor = runtime.attachmentRecoveryDescriptor(
        attachment,
        scope,
      )!;
      const changed = structuredClone(descriptor);
      (changed.locator as unknown as Record<string, unknown>)[field] =
        field === "runtimeGeneration" ? 4 : "different";
      // The retained integrity digest detects independent locator corruption;
      // current durable source authorization remains a separate service gate.
      expect(runtime.rehydrateAttachment(changed, scope)).toBeNull();
    } finally {
      await runtime.shutdown();
    }
  });

  it("never identifies an ordinary unknown document or malformed/borrowed metadata", async () => {
    const runtime = createChatSdkEndpointRuntime(options);
    try {
      const ordinary = runtime.parseTelegramCommandMessage(
        raw("document", TELEGRAM_VIDEO_NOTE_MP4),
      )!.attachments[0]!;
      expect(hasTelegramMediaProvenance(ordinary)).toBe(false);
      expect(
        identifyTelegramMedia(ordinary, TELEGRAM_VIDEO_NOTE_MP4),
      ).toBeNull();
      const invalid = runtime.parseTelegramCommandMessage(
        raw("video", TELEGRAM_VIDEO_NOTE_MP4, { duration: -1 }),
      )!.attachments[0]!;
      expect(hasTelegramMediaProvenance(invalid)).toBe(false);
      const attachment = runtime.parseTelegramCommandMessage(
        raw("video", TELEGRAM_VIDEO_NOTE_MP4),
      )!.attachments[0]!;
      attachment.size = 1;
      expect(
        runtime.attachmentRecoveryDescriptor(attachment, scope),
      ).toBeNull();
      expect(
        identifyTelegramMedia(attachment, TELEGRAM_VIDEO_NOTE_MP4),
      ).toBeNull();
    } finally {
      await runtime.shutdown();
    }
  });

  it("rejects truncated, corrupt, wrong-kind and random media without decoding", async () => {
    const runtime = createChatSdkEndpointRuntime(options);
    try {
      const voice = runtime.parseTelegramCommandMessage(
        raw("voice", TELEGRAM_VOICE_OGG),
      )!.attachments[0]!;
      const video = runtime.parseTelegramCommandMessage(
        raw("video", TELEGRAM_VIDEO_NOTE_MP4),
      )!.attachments[0]!;
      const corrupt = Buffer.from(TELEGRAM_VOICE_OGG);
      corrupt[corrupt.length - 1] ^= 1;
      for (const bytes of [
        Buffer.alloc(0),
        TELEGRAM_VOICE_OGG.subarray(0, 20),
        corrupt,
        TELEGRAM_VIDEO_NOTE_MP4,
      ])
        expect(identifyTelegramMedia(voice, bytes)).toBeNull();
      expect(identifyTelegramMedia(video, TELEGRAM_AUDIO_MP4)).toBeNull();
      expect(
        identifyTelegramMedia(video, TELEGRAM_VIDEO_NOTE_MP4.subarray(0, -1)),
      ).toBeNull();
      for (let size = 0; size < 512; size++) {
        const random = Buffer.alloc(size, (size * 31) & 255);
        expect(() => identifyTelegramMedia(video, random)).not.toThrow();
        expect(identifyTelegramMedia(video, random)).toBeNull();
      }
    } finally {
      await runtime.shutdown();
    }
  });
});
