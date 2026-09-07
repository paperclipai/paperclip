import { describe, expect, it, vi } from "vitest";
import { TelegramFormatConverter } from "@chat-adapter/telegram";
import {
  shouldStreamSafePublicationText,
  splitTelegramPublicationText,
  streamSafePublicationText,
  TELEGRAM_DURABLE_PART_CODE_POINTS,
  telegramMarkdownRequiresAttachment,
} from "./chat-publication-stream.js";

describe("safe chat publication streaming", () => {
  it("reconstructs externally projected text without splitting code points", async () => {
    const source = "abc😀def";
    const chunks: string[] = [];
    for await (const chunk of streamSafePublicationText(source, {
      chunkCodePoints: 4,
      delayMs: 0,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["abc😀", "def"]);
    expect(chunks.join("")).toBe(source);
  });

  it("uses bounded pacing between chunks and never after the final chunk", async () => {
    const wait = vi.fn(async () => undefined);
    const chunks: string[] = [];
    for await (const chunk of streamSafePublicationText("abcdef", {
      chunkCodePoints: 2,
      delayMs: 25,
      wait,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["ab", "cd", "ef"]);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 25);
  });

  it("streams only responses large enough to benefit", () => {
    expect(shouldStreamSafePublicationText("short")).toBe(false);
    expect(shouldStreamSafePublicationText("x".repeat(281))).toBe(true);
  });

  it("splits Telegram publications losslessly on Unicode code-point boundaries", () => {
    const source = `${"*".repeat(TELEGRAM_DURABLE_PART_CODE_POINTS)}${"🙂".repeat(
      TELEGRAM_DURABLE_PART_CODE_POINTS,
    )}tail`;

    const parts = splitTelegramPublicationText(source);

    expect(parts).toHaveLength(3);
    expect(parts.join("")).toBe(source);
    expect(
      parts.every(
        (part) => Array.from(part).length <= TELEGRAM_DURABLE_PART_CODE_POINTS,
      ),
    ).toBe(true);
  });

  it("keeps long ordinary Telegram prose inline and splits on readable boundaries", () => {
    const source = `${"A readable sentence with words. ".repeat(90)}Tail.`;

    expect(telegramMarkdownRequiresAttachment(source)).toBe(false);
    const parts = splitTelegramPublicationText(source);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(source);
    expect(
      parts.every(
        (part) => Array.from(part).length <= TELEGRAM_DURABLE_PART_CODE_POINTS,
      ),
    ).toBe(true);
    expect(parts.slice(0, -1).every((part) => /\s$/.test(part))).toBe(true);
  });

  it.each([
    { label: "maximum MarkdownV2 escaping", source: "!".repeat(5_003) },
    { label: "astral Unicode", source: "🙂".repeat(5_003) },
    {
      label: "word-boundary prose",
      source: "A plain Telegram sentence with words. ".repeat(180),
    },
  ])(
    "keeps every long plain-text part below Telegram's post-conversion limit for $label",
    ({ source }) => {
      const converter = new TelegramFormatConverter();
      expect(telegramMarkdownRequiresAttachment(source)).toBe(false);
      const parts = splitTelegramPublicationText(source);
      expect(parts.join("")).toBe(source);
      expect(parts.length).toBeGreaterThan(1);
      expect(
        parts.every(
          (part) => converter.fromMarkdown(part).length <= 4_096,
        ),
      ).toBe(true);
    },
  );

  it.each([
    {
      label: "a fenced code block",
      source: `\`\`\`text\n${"const result = true;\n".repeat(100)}\`\`\``,
    },
    {
      label: "a link",
      source: `[${"evidence ".repeat(210)}](https://example.test/evidence)`,
    },
    {
      label: "a list",
      source: Array.from(
        { length: 220 },
        (_value, index) => `- Result ${index}`,
      ).join("\n"),
    },
  ])(
    "uses one Markdown attachment when a long Telegram response contains $label",
    ({ source }) => {
      const converter = new TelegramFormatConverter();
      expect(Array.from(source).length).toBeGreaterThan(
        TELEGRAM_DURABLE_PART_CODE_POINTS,
      );
      // Use Telegram's own installed converter to prove this is provider
      // Markdown, rather than treating punctuation-like plain text as rich.
      expect(converter.fromMarkdown(source)).not.toBe("");
      expect(telegramMarkdownRequiresAttachment(source)).toBe(true);
    },
  );

  it("keeps short structured Telegram Markdown native", () => {
    expect(telegramMarkdownRequiresAttachment("```ts\nconst ok = true;\n```")).toBe(
      false,
    );
    expect(
      telegramMarkdownRequiresAttachment(
        "[Open the task](https://example.test/task)",
      ),
    ).toBe(false);
  });

  it("uses an attachment when a plain paragraph would split into a Markdown heading", () => {
    const converter = new TelegramFormatConverter();
    const source = `${"x".repeat(1_599)} # Heading ${"tail ".repeat(40)}`;
    const parts = splitTelegramPublicationText(source);

    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatch(/^# Heading/);
    expect(converter.fromMarkdown(source)).toContain("\\# Heading");
    expect(converter.fromMarkdown(parts[1]!)).toMatch(/^\*Heading/);
    expect(telegramMarkdownRequiresAttachment(source)).toBe(true);
  });

  it("keeps a Markdown escape prefix with its escaped punctuation", () => {
    const converter = new TelegramFormatConverter();
    const source = `${"x".repeat(1_599)}\\!${"y".repeat(120)}`;
    const parts = splitTelegramPublicationText(source);

    expect(parts.join("")).toBe(source);
    expect(parts[0]).not.toMatch(/\\$/);
    expect(parts[1]).toMatch(/^\\!/);
    expect(parts.map((part) => converter.fromMarkdown(part)).join("")).toBe(
      converter.fromMarkdown(source),
    );
    expect(telegramMarkdownRequiresAttachment(source)).toBe(false);
  });
});
