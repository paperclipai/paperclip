import { describe, expect, it } from "vitest";
import { createChatSdkEndpointRuntime } from "./chat-sdk-runtime.js";
import { normalizeTelegramRichMessage } from "./chat-telegram-rich-intake.js";
import { identifyTelegramMedia } from "./chat-telegram-media-intake.js";
import { TELEGRAM_VOICE_OGG } from "../__tests__/fixtures/telegram-voice.js";

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
const source = {
  threadId: "telegram:-10077:42",
  messageId: "-10077:70",
  principalExternalId: "77",
  runtimeGeneration: 2,
  credentialFingerprint: "fixture-fingerprint",
};
const raw = (blocks: unknown) => ({
  message_id: 70,
  date: 1_788_700_000,
  message_thread_id: 42,
  chat: { id: -10077, type: "supergroup" },
  from: { id: 77, is_bot: false, first_name: "Fixture" },
  rich_message: { blocks },
});

describe("Telegram bounded current rich inbound projection", () => {
  it("preserves every current text/block shape in document order, without activating controls", () => {
    const value = normalizeTelegramRichMessage(
      raw([
        { type: "heading", size: 1, text: "Heading" },
        {
          type: "paragraph",
          text: [
            "Plain ",
            { type: "bold", text: "bold" },
            {
              type: "button",
              button: { text: "Label", callback_data: "PRIVATE_CALLBACK" },
            },
          ],
        },
        { type: "pre", text: "const x = 1;", language: "typescript" },
        { type: "expandable_blockquote", text: "Quote", credit: "Author" },
        {
          type: "blockquote",
          blocks: [{ type: "paragraph", text: "Nested" }],
          credit: "Credit",
        },
        { type: "pullquote", text: "Pull", credit: "Pull credit" },
        {
          type: "details",
          summary: "Summary",
          blocks: [{ type: "footer", text: "Details" }],
        },
        {
          type: "list",
          items: [
            {
              label: "1.",
              has_checkbox: true,
              is_checked: true,
              blocks: [{ type: "paragraph", text: "Item" }],
            },
          ],
        },
        {
          type: "table",
          cells: [
            [{ text: "A" }, { text: "B" }],
            [{ text: "C" }, {}],
          ],
          caption: "Table",
        },
        {
          type: "map",
          location: { latitude: 10, longitude: 20 },
          caption: { text: "Map", credit: "Map credit" },
        },
        {
          type: "buttons",
          buttons: [
            { text: "Link", url: "https://example.com" },
            { text: "Control", callback_data: "PRIVATE_CALLBACK" },
          ],
        },
        { type: "mathematical_expression", expression: "x^2" },
        {
          type: "paragraph",
          text: [
            { type: "custom_emoji", alternative_text: "🙂" },
            { type: "mathematical_expression", expression: "y^2" },
            { type: "url", text: "Source", url: "https://example.org" },
          ],
        },
        { type: "divider" },
        { type: "anchor", name: "hidden-anchor" },
      ]),
    )!;
    expect(value.text).toBe(
      "Heading\n\nPlain boldLabel [Interactive button; no action was performed.]\n\nconst x = 1;\n\nQuote\n\nAuthor\n\nNested\n\nCredit\n\nPull\n\nPull credit\n\nSummary\n\nDetails\n\n1. [x] Item\n\nTable\n\nA\tB\nC\t\n\nLocation: 10, 20\n\nMap\n\nMap credit\n\nLink (https://example.com) | Control [Interactive button; no action was performed.]\n\nx^2\n\n🙂y^2Source (https://example.org)\n\n---",
    );
    expect(value.text).not.toContain("PRIVATE_CALLBACK");
  });

  it.each([
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "spoiler",
    "date_time",
    "text_mention",
    "subscript",
    "superscript",
    "marked",
    "code",
    "bank_card_number",
    "mention",
    "hashtag",
    "cashtag",
    "bot_command",
    "anchor_link",
    "reference",
    "reference_link",
  ])("retains nested visible %s text", (type) => {
    expect(
      normalizeTelegramRichMessage(
        raw([{ type: "paragraph", text: { type, text: ["Exact ", "tail"] } }]),
      )?.text,
    ).toBe("Exact tail");
  });

  it("reconstructs native rich files with exact block path/source proof and identifies optional-MIME voice", async () => {
    const runtime = createChatSdkEndpointRuntime(options);
    const fresh = createChatSdkEndpointRuntime(options);
    try {
      const message = runtime.parseTelegramCommandMessage(
        raw([
          {
            type: "details",
            summary: "Files",
            blocks: [
              {
                type: "document",
                document: {
                  file_id: "doc",
                  file_unique_id: "doc-unique",
                  file_name: "source.txt",
                  mime_type: "text/plain",
                  file_size: 20,
                },
              },
              {
                type: "voice_note",
                voice_note: {
                  file_id: "voice",
                  file_unique_id: "voice-unique",
                  duration: 1,
                  file_size: TELEGRAM_VOICE_OGG.length,
                },
              },
            ],
          },
        ]),
      )!;
      expect(message.attachments).toHaveLength(2);
      const descriptors = message.attachments.map((attachment) =>
        runtime.attachmentRecoveryDescriptor(attachment, source)!,
      );
      expect(descriptors[0].locator).toMatchObject({
        kind: "telegram_media",
        media: "rich_document",
        richPath: '["blocks",0,"blocks",0]',
        fileId: "doc",
      });
      const restored = descriptors.map((descriptor) =>
        fresh.rehydrateAttachment(structuredClone(descriptor), source)!,
      );
      expect(restored[0].fetchMetadata).toEqual({
        fileId: "doc",
        fileUniqueId: "doc-unique",
      });
      expect(identifyTelegramMedia(restored[1], TELEGRAM_VOICE_OGG)).toBe(
        "audio/ogg",
      );
      for (const field of [
        "richPath",
        "fileId",
        "fileUniqueId",
        "companyId",
        "endpointId",
        "messageId",
        "threadId",
        "principalExternalId",
        "credentialFingerprint",
        "sourceSha256",
      ]) {
        const changed = structuredClone(descriptors[0]);
        (changed.locator as unknown as Record<string, unknown>)[field] =
          "different";
        expect(fresh.rehydrateAttachment(changed, source)).toBeNull();
      }
      expect(
        fresh.rehydrateAttachment(descriptors[0], {
          ...source,
          runtimeGeneration: 3,
        }),
      ).toBeNull();
    } finally {
      await runtime.shutdown();
      await fresh.shutdown();
    }
  });

  it.each([
    { blocks: [{ type: "unknown_future", text: "PRIVATE_UNKNOWN" }] },
    {
      blocks: [
        {
          type: "paragraph",
          text: { type: "unknown_text", text: "PRIVATE_UNKNOWN" },
        },
      ],
    },
    { blocks: [{ type: "list", items: null }] },
    { blocks: [null] },
  ])(
    "reports unsupported or malformed rich input without guessing hidden fields",
    ({ blocks }) => {
      const value = normalizeTelegramRichMessage(raw(blocks))!;
      expect(value.text).toContain("could not import");
      expect(value.text).not.toContain("PRIVATE_UNKNOWN");
    },
  );

  it("bounds traversal and output before legacy parsing and never exports thinking", async () => {
    const runtime = createChatSdkEndpointRuntime(options);
    try {
      const cycle: Record<string, unknown> = {
        type: "details",
        summary: "Cycle",
      };
      cycle.blocks = [cycle];
      for (const blocks of [
        [cycle],
        [{ type: "paragraph", text: "x".repeat(100_001) }],
        [{ type: "table", cells: [Array.from({ length: 5000 }, () => ({}))] }],
      ]) {
        const message = runtime.parseTelegramCommandMessage(raw(blocks))!;
        expect(message.text).toContain("exceeded the supported import limit");
        expect(message.attachments).toEqual([]);
      }
      const hidden = runtime.parseTelegramCommandMessage(
        raw([
          { type: "thinking", text: "PRIVATE_THINKING" },
          { type: "paragraph", text: "Visible answer" },
        ]),
      )!;
      expect(hidden.text).toContain("Visible answer");
      expect(
        JSON.stringify({ text: hidden.text, formatted: hidden.formatted }),
      ).not.toContain("PRIVATE_THINKING");
      expect(
        normalizeTelegramRichMessage(
          raw([{ type: "paragraph", text: "x".repeat(100_000) }]),
        )?.text,
      ).toHaveLength(100_000);
    } finally {
      await runtime.shutdown();
    }
  });

  it("never grants ordinary file provenance to ephemeral or malformed native source identity", async () => {
    const runtime = createChatSdkEndpointRuntime(options);
    try {
      for (const change of [
        { message_id: 0, ephemeral_message_id: "ephemeral" },
        { receiver_user: { id: 77 } },
        { from: { id: "77" } },
      ]) {
        const message = runtime.parseTelegramCommandMessage({
          ...raw([
            {
              type: "document",
              document: {
                file_id: "doc",
                file_unique_id: "unique",
                mime_type: "text/plain",
              },
            },
          ]),
          ...change,
        })!;
        expect(message.attachments).toEqual([{ type: "file" }]);
      }
    } finally {
      await runtime.shutdown();
    }
  });

  it("distinguishes file-only lifecycle revisions without retaining private locators", () => {
    const a = raw([
      {
        type: "document",
        document: {
          file_id: "first",
          file_unique_id: "u1",
          mime_type: "text/plain",
        },
      },
    ]);
    const b = raw([
      {
        type: "document",
        document: {
          file_id: "second",
          file_unique_id: "u2",
          mime_type: "text/plain",
        },
      },
    ]);
    expect(normalizeTelegramRichMessage(a)?.mediaDigest).not.toBe(
      normalizeTelegramRichMessage(b)?.mediaDigest,
    );
    expect(normalizeTelegramRichMessage(a)?.mediaDigest).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
});
