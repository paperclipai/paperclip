import { SlackFormatConverter } from "@chat-adapter/slack";
import { TeamsFormatConverter } from "@chat-adapter/teams";
import {
  convertEmojiPlaceholders,
  parseMarkdown,
  stringifyMarkdown,
} from "chat";
import type { SafeChatPublicationPayload } from "@paperclipai/shared";

type NativeTextProvider = "slack" | "github" | "microsoft-teams";
export interface NativePublicationTextPart {
  text: string;
  prefix?: string;
  suffix?: string;
}
const slack = new SlackFormatConverter();
const teams = new TeamsFormatConverter();
const MAX_WRAPPER_LENGTH = 292;
const PREFIX = /^(`{3,256}|~{3,256})([A-Za-z0-9_+.-]{0,32})\n$/;
const SUFFIX = /^\n(`{3,256}|~{3,256})\n?$/;

function invalidTransport(): never {
  throw Object.assign(new Error("Invalid durable publication text transport"), {
    name: "ValidationError",
    code: "VALIDATION_ERROR",
  });
}

/** Never accept arbitrary persisted prose, links, or credentials as a wrapper. */
export function renderPublicationTransportText(
  payload: SafeChatPublicationPayload,
): string {
  const part = payload.transportPart;
  const prefix: unknown = part?.prefix;
  const suffix: unknown = part?.suffix;
  if (prefix === undefined && suffix === undefined) return payload.text;
  if (part?.mode && part.mode !== "inline") invalidTransport();
  if (
    prefix !== undefined &&
    (typeof prefix !== "string" ||
      prefix.length > MAX_WRAPPER_LENGTH ||
      !PREFIX.test(prefix))
  )
    invalidTransport();
  if (
    suffix !== undefined &&
    (typeof suffix !== "string" ||
      suffix.length > MAX_WRAPPER_LENGTH ||
      !SUFFIX.test(suffix))
  )
    invalidTransport();
  if (
    prefix !== undefined &&
    suffix !== undefined &&
    PREFIX.exec(prefix as string)![1] !== SUFFIX.exec(suffix as string)![1]
  )
    invalidTransport();
  return `${prefix ?? ""}${payload.text}${suffix ?? ""}`;
}

/** Pinned post/edit renderings, with conservative UTF-16 and encoded-byte ceilings. */
export function nativePublicationTextFits(
  provider: NativeTextProvider,
  text: string,
): boolean {
  return nativePublicationTextSize(provider, text) <= nativeLimit(provider);
}
function nativeLimit(provider: NativeTextProvider): number {
  return provider === "slack"
    ? 12_000
    : provider === "github"
      ? 60_000
      : 64_000;
}
function nativePublicationTextSize(
  provider: NativeTextProvider,
  text: string,
): number {
  // Cheap reject before parsing a large document on every candidate probe.
  const sourceLimit =
    provider === "slack" ? 12_000 : provider === "github" ? 60_000 : 32_000;
  if (text.length > sourceLimit) return Infinity;
  // The pinned Markdown parser can do superlinear work on very long labels or
  // dense escapes. Large rich blocks take the bounded literal-source path;
  // ordinary prose and fenced code remain cheap native renderings.
  if (provider !== "slack" && expensiveRichBlock(text)) return Infinity;
  const slackPayload =
    provider === "slack" ? slack.toSlackPayload({ markdown: text }) : null;
  const rendered =
    provider === "slack"
      ? slackPayload && "markdown_text" in slackPayload
        ? slackPayload.markdown_text
        : invalidTransport()
      : provider === "github"
        ? convertEmojiPlaceholders(
            stringifyMarkdown(parseMarkdown(text)).trim(),
            "github",
          )
        : convertEmojiPlaceholders(
            teams.renderPostable({ markdown: text }),
            "teams",
          );
  return provider === "slack"
    ? rendered.length
    : provider === "github"
      ? Math.max(rendered.length, Buffer.byteLength(rendered, "utf8"))
      : rendered.length * 2;
}

type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  lang?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
};
function expensiveRichBlock(text: string): boolean {
  return (
    text.length > 16_000 &&
    !/^(?:`{3,256}|~{3,256})[^\n]*\n/.test(text) &&
    /[\\[\]_*|<>]/.test(text)
  );
}
function boundedMarkdownBlocks(text: string): MarkdownNode[] {
  if (text.length <= 16_000)
    return (parseMarkdown(text) as MarkdownNode).children ?? [];
  const nodes: MarkdownNode[] = [];
  let start = 0;
  let fence: { character: string; length: number } | null = null;
  const add = (end: number, force = false) => {
    // Group small complete blocks before parsing/sizing. A document of 33k
    // tiny paragraphs must not cause 33k independent Markdown parses.
    if (end <= start || (!force && end - start < 8_000)) return;
    const block = text.slice(start, end);
    let node: MarkdownNode;
    if (block.length <= 16_000) {
      const children = (parseMarkdown(block) as MarkdownNode).children ?? [];
      node = children.length === 1 ? children[0]! : { type: "literal" };
    } else if (/^(`{3,256}|~{3,256})[^\n]*\n/.test(block))
      node = { type: "code" };
    else
      node = {
        type: /[\\[\]_*`~|<>#]|(?:^|\n)\s*(?:[-+]|\d+[.)])\s/.test(block)
          ? "literal"
          : "paragraph",
      };
    nodes.push({
      ...node,
      position: { start: { offset: start }, end: { offset: end } },
    });
    start = end;
  };
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const line = match[0].replace(/\r?\n$/, "");
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) {
        add(match.index!, true);
        fence = { character: marker[1]![0]!, length: marker[1]!.length };
      } else if (
        marker[1]![0] === fence.character &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = null;
    }
    if (!fence && !line.trim()) add(match.index! + match[0].length);
  }
  if (start < text.length) add(text.length, true);
  return nodes;
}
function plain(node: MarkdownNode): boolean {
  return (
    ["root", "paragraph", "text", "break"].includes(node.type) &&
    (node.children?.every(plain) ?? true)
  );
}
function literalFence(text: string): string {
  const longest = (character: string) => {
    let length = 2;
    for (const match of text.matchAll(new RegExp(`${character}{3,}`, "g")))
      length = Math.max(length, match[0].length);
    return length;
  };
  const backticks = longest("`");
  const tildes = longest("~");
  const length = Math.min(backticks, tildes) + 1;
  if (length > 256) return "";
  return (backticks <= tildes ? "`" : "~").repeat(length);
}

/**
 * Native, durable, ordered text. Whole Markdown blocks stay together whenever
 * possible. A split code block is closed/reopened; an oversized indivisible
 * rich block is displayed as complete Markdown source, never partial markup.
 * Joining `text` (not the rendering wrappers) reconstructs the safe source.
 */
export function splitNativePublicationText(
  provider: NativeTextProvider,
  text: string,
): NativePublicationTextPart[] {
  const renderedSizes = new Map<string, number>();
  const sizeOf = (value: string) => {
    const cached = renderedSizes.get(value);
    if (cached !== undefined) return cached;
    const size = nativePublicationTextSize(provider, value);
    renderedSizes.set(value, size);
    return size;
  };
  const fits = (value: string) => sizeOf(value) <= nativeLimit(provider);
  if (fits(text)) return [{ text }];
  const parts: NativePublicationTextPart[] = [];
  const sizes = new Map<NativePublicationTextPart, number>();
  const append = (part: NativePublicationTextPart) => {
    const previous = parts.at(-1);
    const size = sizeOf(`${part.prefix ?? ""}${part.text}${part.suffix ?? ""}`);
    const combinedSize =
      (previous ? sizes.get(previous)! : Infinity) + size + 8;
    const sourceLimit =
      provider === "slack" ? 12_000 : provider === "github" ? 60_000 : 32_000;
    if (
      previous &&
      !previous.prefix &&
      !previous.suffix &&
      !part.prefix &&
      !part.suffix &&
      previous.text.length + part.text.length <= sourceLimit &&
      (provider === "slack" ||
        !expensiveRichBlock(previous.text + part.text)) &&
      combinedSize <= nativeLimit(provider)
    ) {
      previous.text += part.text;
      sizes.set(previous, combinedSize);
    } else {
      parts.push(part);
      sizes.set(part, size);
    }
  };
  // Definitions cannot be carried to another native message invisibly. For a
  // split reference document retain the complete source as visible Markdown.
  const hasReferences = /^ {0,3}\[[^\r\n]*\]:/m.test(text);
  const children = hasReferences
    ? [{ type: "literal" } as MarkdownNode]
    : boundedMarkdownBlocks(text);
  let start = 0;
  for (let index = 0; index < children.length; index++) {
    const node = children[index]!;
    const end =
      index + 1 === children.length
        ? text.length
        : children[index + 1]!.position?.start.offset;
    if (end === undefined || end <= start) invalidTransport();
    const block = text.slice(start, end);
    start = end;
    if (fits(block)) {
      append({ text: block });
      continue;
    }
    const fenceMatch =
      node.type === "code"
        ? /^(`{3,256}|~{3,256})([A-Za-z0-9_+.-]{0,32})\n/.exec(block)
        : null;
    const isPlain = plain(node);
    let offset = 0;
    while (offset < block.length) {
      let size = Math.min(
        provider === "slack" ? 10_000 : 24_000,
        block.length - offset,
      );
      let selected: NativePublicationTextPart | undefined;
      while (!selected) {
        let next = offset + size;
        if (next < block.length && /[\uD800-\uDBFF]/.test(block[next - 1]!))
          next--;
        if (next <= offset) invalidTransport();
        // Prefer a paragraph/line/word break, without discarding its separator.
        if (next < block.length) {
          for (const separator of ["\n\n", "\n", " "]) {
            const candidate = block.lastIndexOf(
              separator,
              next - separator.length,
            );
            if (candidate >= offset + Math.floor(size / 2)) {
              next = candidate + separator.length;
              break;
            }
          }
          // Keep escaped punctuation together so the next part cannot turn it
          // into a fresh Markdown construct.
          let escapes = 0;
          for (let at = next - 1; at >= offset && block[at] === "\\"; at--)
            escapes++;
          if (escapes % 2) next--;
        }
        if (next <= offset) invalidTransport();
        const slice = block.slice(offset, next);
        let part: NativePublicationTextPart = { text: slice };
        if (fenceMatch) {
          part = {
            text: slice,
            ...(offset ? { prefix: `${fenceMatch[1]}${fenceMatch[2]}\n` } : {}),
            ...(next < block.length ? { suffix: `\n${fenceMatch[1]}\n` } : {}),
          };
        } else if (!isPlain || !plain(parseMarkdown(slice) as MarkdownNode)) {
          const fence = literalFence(slice);
          if (fence)
            part = { text: slice, prefix: `${fence}\n`, suffix: `\n${fence}` };
          else {
            size = Math.floor(size / 2);
            continue;
          }
        }
        const rendered = `${part.prefix ?? ""}${part.text}${part.suffix ?? ""}`;
        if (fits(rendered)) selected = part;
        else {
          size = Math.floor(size / 2);
          if (size < 1) invalidTransport();
        }
      }
      append(selected);
      offset += selected.text.length;
    }
  }
  if (
    start !== text.length ||
    parts.map((part) => part.text).join("") !== text ||
    parts.some(
      (part) => !fits(`${part.prefix ?? ""}${part.text}${part.suffix ?? ""}`),
    )
  )
    invalidTransport();
  return parts;
}
