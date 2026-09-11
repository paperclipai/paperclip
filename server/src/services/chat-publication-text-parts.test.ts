import { describe, expect, it } from "vitest";
import { SlackFormatConverter } from "@chat-adapter/slack";
import { TeamsFormatConverter } from "@chat-adapter/teams";
import {
  convertEmojiPlaceholders,
  parseMarkdown,
  stringifyMarkdown,
} from "chat";
import type { SafeChatPublicationPayload } from "@paperclipai/shared";
import {
  nativePublicationTextFits,
  renderPublicationTransportText,
  splitNativePublicationText,
} from "./chat-publication-text-parts.js";

function slackMarkdown(text: string) {
  const payload = new SlackFormatConverter().toSlackPayload({ markdown: text });
  if (!("markdown_text" in payload))
    throw new Error("Expected pinned Slack markdown contract");
  return payload.markdown_text;
}

describe("lossless native publication text parts", () => {
  it.each(["slack", "github", "microsoft-teams"] as const)(
    "preserves complete %s source within actual converter budgets",
    (provider) => {
      const sources = [
        "a".repeat(99_996) + "TAIL",
        "A useful paragraph with words.\n\n".repeat(4_000) + "TAIL",
        "😀".repeat(49_998) + "TAIL",
        "@here ".repeat(16_666) + "TAIL",
        "```ts\n" + "const answer = 47;\n".repeat(6_000) + "```\n\nTAIL",
        "**" + "bold ".repeat(20_000) + "**\n\nTAIL",
        "[" + "label ".repeat(17_000) + "](https://example.com)\n\nTAIL",
        "| Column |\n| --- |\n" + "| " + "cell ".repeat(20_000) + " |\n\nTAIL",
        "[report][ref]\n\n" +
          "text ".repeat(20_000) +
          "\n\n[ref]: https://example.com\n\nTAIL",
        "a\\*b ".repeat(20_000) + "TAIL",
      ];
      for (const source of sources) {
        const parts = splitNativePublicationText(provider, source);
        expect(parts.length).toBeGreaterThan(1);
        expect(parts.map((part) => part.text).join("")).toBe(source);
        expect(parts.at(-1)!.text).toContain("TAIL");
        for (const [index, part] of parts.entries()) {
          const rendered = renderPublicationTransportText({
            text: part.text,
            transportPart: {
              batchId: "fixture",
              count: parts.length,
              index,
              orderKey: String(index),
              prefix: part.prefix,
              suffix: part.suffix,
            },
          });
          expect(nativePublicationTextFits(provider, rendered)).toBe(true);
          expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part.text)).toBe(
            false,
          );
          if (provider === "slack")
            expect(slackMarkdown(rendered).length).toBeLessThanOrEqual(12_000);
          if (provider === "github")
            expect(
              Buffer.byteLength(
                convertEmojiPlaceholders(
                  stringifyMarkdown(parseMarkdown(rendered)).trim(),
                  "github",
                ),
                "utf8",
              ),
            ).toBeLessThanOrEqual(60_000);
          if (provider === "microsoft-teams")
            expect(
              convertEmojiPlaceholders(
                new TeamsFormatConverter().renderPostable({
                  markdown: rendered,
                }),
                "teams",
              ).length * 2,
            ).toBeLessThanOrEqual(64_000);
        }
      }
    },
  );

  it("preserves small rich messages and closes each continued code block", () => {
    const small = "A **rich** [link](https://example.com).";
    expect(splitNativePublicationText("slack", small)).toEqual([
      { text: small },
    ]);
    const source = "```ts\n" + "const answer = 47;\n".repeat(2_000) + "```";
    for (const [index, part] of splitNativePublicationText(
      "slack",
      source,
    ).entries()) {
      const rendered = `${part.prefix ?? ""}${part.text}${part.suffix ?? ""}`;
      expect(parseMarkdown(rendered).children.map((node) => node.type)).toEqual(
        ["code"],
      );
      if (index > 0) expect(part.prefix).toBe("```ts\n");
    }
  });

  it("bounds the real Slack markdown field rather than its legacy text field", () => {
    expect(nativePublicationTextFits("slack", "a".repeat(12_000))).toBe(true);
    expect(nativePublicationTextFits("slack", "a".repeat(12_001))).toBe(false);
    const source = "@U12345678 ".repeat(1_080);
    expect(source.length).toBeLessThan(12_000);
    expect(slackMarkdown(source).length).toBeGreaterThan(12_000);
    expect(splitNativePublicationText("slack", source).length).toBeGreaterThan(
      1,
    );
  });

  it.each(["slack", "github", "microsoft-teams"] as const)(
    "groups a maximum-size %s document of tiny paragraphs without per-paragraph transport overhead",
    (provider) => {
      const source = "x\n\n".repeat(33_332) + "TAIL";
      expect(source.length).toBe(100_000);
      const parts = splitNativePublicationText(provider, source);
      expect(parts.map((part) => part.text).join("")).toBe(source);
      expect(parts.length).toBeLessThanOrEqual(13);
      for (const part of parts) {
        expect(part.prefix).toBeUndefined();
        expect(part.suffix).toBeUndefined();
        expect(nativePublicationTextFits(provider, part.text)).toBe(true);
      }
    },
  );

  it.each([
    { prefix: "https://private.example/?token=PRIVATE" },
    { suffix: "SECRET" },
    { prefix: 47 },
    { suffix: {} },
    { prefix: "`".repeat(257) + "\n" },
    { prefix: "```bad language\n" },
    { prefix: "```\n", suffix: "\n~~~" },
    { prefix: "```\n", mode: "discord_markdown_attachment" },
  ])("refuses malformed persisted wrapper %#", (fields) => {
    expect(() =>
      renderPublicationTransportText({
        text: "safe",
        transportPart: {
          batchId: "fixture",
          count: 2,
          index: 0,
          orderKey: "fixture:0",
          ...fields,
        },
      } as SafeChatPublicationPayload),
    ).toThrow("Invalid durable publication text transport");
  });
});
