import {
  OMITTED_PROVIDER_TEXT,
  type OmittedProviderText,
} from "../../provider-events.js";

/**
 * Bounds for the OpenCode `/event` stream. A frame within `frameChars` is
 * retained exactly. A larger frame keeps its JSON structure and short strings,
 * while long strings keep a head and a tail. A tool part therefore keeps its
 * identity, status and output tail even when OpenCode attaches megabytes of
 * command output or file contents to one event.
 */
export const OPENCODE_SSE_LIMITS = {
  frameChars: 1_048_576,
  shortStringChars: 256,
  stringHeadChars: 4 * 1024,
  stringTailChars: 64 * 1024,
  stringBudgetChars: 768 * 1024,
  compactedChars: 2 * 1_048_576,
  truncations: 64,
} as const;

export interface OpenCodeSseTruncation {
  path: Array<string | number>;
  chars: number;
  bytes: number;
  omittedChars: number;
}

export interface OpenCodeSseCompaction {
  /** Characters of SSE data received for the oversized frame. */
  frameChars: number;
  truncatedStrings: number;
  omittedChars: number;
  /** Shortened string values, in stream order. Bounded by `truncations`. */
  truncations: OpenCodeSseTruncation[];
  /** Top-level OpenCode event type, when the frame exposed one. */
  eventType: string | null;
  /**
   * The compacted structure still exceeded `compactedChars`, so no event
   * could be retained. The consumer must report this frame, not parse it.
   */
  omitted: boolean;
}

export interface OpenCodeSseFrame {
  raw: string;
  data: string;
  compaction?: OpenCodeSseCompaction;
}

export async function* parseOpenCodeSseFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<OpenCodeSseFrame> {
  const decoder = new TextDecoder();
  const parser = new OpenCodeSseParser();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
    yield* parser.push(decoder.decode(chunk, { stream: true }));
}

/**
 * Records the real size of each string that compaction shortened on the
 * object that owns it, so canonical tool payloads report the provider's
 * output size instead of the excerpt size.
 */
export function annotateOmittedProviderText(
  event: unknown,
  compaction: OpenCodeSseCompaction,
): void {
  for (const truncation of compaction.truncations) {
    const key = truncation.path.at(-1);
    if (typeof key !== "string") continue;
    let owner: unknown = event;
    for (const segment of truncation.path.slice(0, -1)) {
      owner =
        typeof owner === "object" && owner !== null
          ? (owner as Record<string | number, unknown>)[segment]
          : undefined;
    }
    if (typeof owner !== "object" || owner === null || Array.isArray(owner))
      continue;
    const target = owner as Record<PropertyKey, unknown>;
    target[OMITTED_PROVIDER_TEXT] = {
      ...(target[OMITTED_PROVIDER_TEXT] as Record<string, OmittedProviderText> | undefined),
      [key]: { chars: truncation.chars, bytes: truncation.bytes },
    };
  }
}

class OpenCodeSseParser {
  #buffer = "";
  #oversized: OversizedSseFrame | null = null;

  push(text: string): OpenCodeSseFrame[] {
    const frames: OpenCodeSseFrame[] = [];
    let rest = text;
    while (rest) {
      if (this.#oversized) {
        const consumed = this.#oversized.write(rest);
        if (consumed < 0) return frames;
        frames.push(this.#oversized.finish());
        this.#oversized = null;
        rest = rest.slice(consumed);
        continue;
      }
      this.#buffer += rest;
      rest = "";
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(this.#buffer)) !== null) {
        const rawFrame = this.#buffer.slice(0, boundary.index);
        const raw = this.#buffer.slice(0, boundary.index + boundary[0].length);
        this.#buffer = this.#buffer.slice(boundary.index + boundary[0].length);
        if (rawFrame.length > OPENCODE_SSE_LIMITS.frameChars) {
          const oversized = new OversizedSseFrame();
          oversized.write(raw);
          frames.push(oversized.finish());
          continue;
        }
        const data = rawFrame
          .replaceAll("\r", "")
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        frames.push({ raw, data });
      }
      // Only the unterminated frame remains. Stream it through the compactor
      // instead of retaining it or abandoning the whole event stream.
      const separatorChars = /(?:\r\n\r|\r\n|[\r\n])$/.exec(this.#buffer)?.[0].length ?? 0;
      if (this.#buffer.length - separatorChars > OPENCODE_SSE_LIMITS.frameChars) {
        this.#oversized = new OversizedSseFrame();
        rest = this.#buffer;
        this.#buffer = "";
      }
    }
    return frames;
  }
}

/** Streams the `data:` lines of one oversized SSE frame into the compactor. */
class OversizedSseFrame {
  readonly #json = new BoundedJsonCompactor();
  #lineStarted = false;
  #frameStarted = false;
  #lineKind: "pending" | "data" | "other" = "pending";
  #lineHead = "";
  #dataLines = 0;

  /** Returns the index after the frame's blank line, or -1 if it continues. */
  write(text: string): number {
    let index = 0;
    while (index < text.length) {
      const newline = text.indexOf("\n", index);
      const end = newline < 0 ? text.length : newline;
      if (end > index) this.#segment(text.slice(index, end).replaceAll("\r", ""));
      if (newline < 0) return -1;
      index = newline + 1;
      // A blank line ends the frame. Blank lines before its first field are
      // separator leftovers from the previous frame.
      if (!this.#lineStarted) {
        if (this.#frameStarted) return index;
        continue;
      }
      this.#lineStarted = false;
      this.#lineKind = "pending";
      this.#lineHead = "";
    }
    return -1;
  }

  finish(): OpenCodeSseFrame {
    const { data, compaction } = this.#json.finish();
    return { raw: data ? `data: ${data}\n\n` : "", data, compaction };
  }

  #segment(segment: string): void {
    if (!segment) return;
    this.#lineStarted = true;
    this.#frameStarted = true;
    let value = segment;
    if (this.#lineKind === "pending") {
      const head = this.#lineHead + value;
      if (head.length < 5) {
        if ("data:".startsWith(head)) this.#lineHead = head;
        else this.#lineKind = "other";
        return;
      }
      if (!head.startsWith("data:")) {
        this.#lineKind = "other";
        return;
      }
      this.#lineKind = "data";
      this.#lineHead = "";
      if (this.#dataLines++ > 0) this.#json.write("\n");
      value = head.slice(5);
    }
    if (this.#lineKind === "data") this.#json.write(value);
  }
}

const TOOL_OUTCOME_TEXT_PATHS = new Set([
  ["properties", "part", "state", "output"],
  ["properties", "part", "state", "error"],
  ["properties", "part", "output"],
].map(path => JSON.stringify(path)));

interface JsonContainer {
  array: boolean;
  key: string | number | null;
  index: number;
  expectKey: boolean;
}

/**
 * Re-emits a JSON document with long strings shortened. Structure, numbers,
 * literals and short strings are copied, so a valid input yields a valid
 * output. Memory is bounded by the retained output plus one string's head and
 * tail.
 */
class BoundedJsonCompactor {
  #out: string[] = [];
  #outChars = 0;
  #stack: JsonContainer[] = [];
  #pendingKey: string | null = null;
  #string: JsonStringReader | null = null;
  #failed = false;
  #inputChars = 0;
  #budget: number = OPENCODE_SSE_LIMITS.stringBudgetChars - TOOL_OUTCOME_TEXT_PATHS.size *
    (OPENCODE_SSE_LIMITS.stringHeadChars + OPENCODE_SSE_LIMITS.stringTailChars);
  #truncatedStrings = 0;
  #omittedChars = 0;
  #truncations: OpenCodeSseTruncation[] = [];
  #eventType: string | null = null;

  write(text: string): void {
    this.#inputChars += text.length;
    let index = 0;
    while (index < text.length && !this.#failed) {
      if (this.#string) {
        index = this.#string.consume(text, index);
        if (this.#string.failed) this.#fail();
        else if (this.#string.done) this.#endString(this.#string);
        continue;
      }
      const char = text[index++]!;
      const top = this.#stack.at(-1);
      switch (char) {
        case '"':
          this.#string = new JsonStringReader(
            Boolean(top && !top.array && top.expectKey),
          );
          break;
        case "{":
        case "[":
          this.#stack.push({
            array: char === "[",
            key: this.#position(),
            index: 0,
            expectKey: char === "{",
          });
          this.#emit(char);
          break;
        case "}":
        case "]":
          this.#stack.pop();
          this.#emit(char);
          break;
        case ":":
          if (top) top.expectKey = false;
          this.#emit(char);
          break;
        case ",":
          if (top?.array) top.index += 1;
          else if (top) top.expectKey = true;
          this.#emit(char);
          break;
        case " ":
        case "\t":
        case "\n":
        case "\r":
          break;
        default:
          this.#emit(char);
      }
    }
  }

  finish(): { data: string; compaction: OpenCodeSseCompaction } {
    const complete =
      !this.#failed && !this.#string && this.#stack.length === 0 && this.#outChars > 0;
    return {
      data: complete ? this.#out.join("") : "",
      compaction: {
        frameChars: this.#inputChars,
        truncatedStrings: this.#truncatedStrings,
        omittedChars: this.#omittedChars,
        truncations: this.#truncations,
        eventType: this.#eventType,
        omitted: !complete,
      },
    };
  }

  #position(): string | number | null {
    const top = this.#stack.at(-1);
    if (!top) return null;
    return top.array ? top.index : this.#pendingKey;
  }

  #endString(reader: JsonStringReader): void {
    this.#string = null;
    const limits = OPENCODE_SSE_LIMITS;
    const path = [
      ...this.#stack.slice(1).map((container) => container.key ?? ""),
      this.#position() ?? "",
    ];
    const pathKey = JSON.stringify(path);
    const outcomeText = !reader.isKey && TOOL_OUTCOME_TEXT_PATHS.has(pathKey);
    const budget = outcomeText ? limits.stringHeadChars + limits.stringTailChars : this.#budget;
    let value: string;
    if (
      !reader.split &&
      (reader.chars <= limits.shortStringChars || reader.chars <= budget)
    ) {
      value = reader.full;
      if (!outcomeText && reader.chars > limits.shortStringChars) this.#budget -= reader.chars;
    } else {
      // The tail carries a command's exit status and final errors, so it has
      // priority over the head when the event budget is nearly spent.
      const head = reader.split ? reader.head : reader.full;
      const tail = reader.split ? reader.tail : reader.full;
      const tailKeep = Math.min(limits.stringTailChars, budget, reader.chars);
      const headKeep = Math.min(
        limits.stringHeadChars,
        budget - tailKeep,
        reader.chars - tailKeep,
      );
      const omittedChars = reader.chars - headKeep - tailKeep;
      value = `${head.slice(0, headKeep)}…[${omittedChars} characters omitted]…${tail.slice(tail.length - tailKeep)}`;
      if (!outcomeText) this.#budget -= headKeep + tailKeep;
      this.#truncatedStrings += 1;
      this.#omittedChars += omittedChars;
      if (!reader.isKey) {
        if (outcomeText) {
          const existing = this.#truncations.findIndex(entry => JSON.stringify(entry.path) === pathKey);
          if (existing >= 0) this.#truncations.splice(existing, 1);
          if (this.#truncations.length >= limits.truncations) {
            const expendable = this.#truncations.findIndex(entry => !TOOL_OUTCOME_TEXT_PATHS.has(JSON.stringify(entry.path)));
            if (expendable >= 0) this.#truncations.splice(expendable, 1);
          }
        }
        if (this.#truncations.length < limits.truncations) {
          this.#truncations.push({ path, chars: reader.chars, bytes: reader.bytes, omittedChars });
        }
      }
    }
    if (reader.isKey) this.#pendingKey = value;
    else if (this.#stack.length === 1 && this.#pendingKey === "type")
      this.#eventType = value.slice(0, 160);
    this.#emit(JSON.stringify(value));
  }

  #emit(value: string): void {
    this.#outChars += value.length;
    if (this.#outChars > OPENCODE_SSE_LIMITS.compactedChars) {
      this.#fail();
      return;
    }
    this.#out.push(value);
  }

  #fail(): void {
    this.#failed = true;
    this.#out = [];
    this.#string = null;
  }
}

/** Decodes one JSON string incrementally and keeps a bounded head and tail. */
class JsonStringReader {
  readonly isKey: boolean;
  full = "";
  head = "";
  tail = "";
  chars = 0;
  bytes = 0;
  split = false;
  done = false;
  failed = false;
  #escape = "";
  #pendingHighSurrogate = "";

  constructor(isKey: boolean) {
    this.isKey = isKey;
  }

  /** Consumes string content from `index`; returns the next unread index. */
  consume(text: string, start: number): number {
    let index = start;
    const special = /["\\]/g;
    while (index < text.length) {
      if (this.#escape) {
        this.#escape += text[index++];
        const length = this.#escape[1] === "u" ? 6 : 2;
        if (this.#escape.length < length) continue;
        const decoded = decodeJsonEscape(this.#escape);
        this.#escape = "";
        if (decoded === null) {
          this.failed = true;
          return text.length;
        }
        this.#append(decoded);
        continue;
      }
      special.lastIndex = index;
      const match = special.exec(text);
      const stop = match ? match.index : text.length;
      if (stop > index) this.#append(text.slice(index, stop));
      if (!match) return text.length;
      index = stop + 1;
      if (match[0] === '"') {
        this.bytes += Buffer.byteLength(this.#pendingHighSurrogate);
        this.#pendingHighSurrogate = "";
        this.done = true;
        return index;
      }
      this.#escape = "\\";
    }
    return index;
  }

  #append(value: string): void {
    const { stringHeadChars, stringTailChars } = OPENCODE_SSE_LIMITS;
    this.chars += value.length;
    const pending = this.#pendingHighSurrogate + value;
    const lastCode = pending.charCodeAt(pending.length - 1);
    const endsHigh = lastCode >= 0xd800 && lastCode <= 0xdbff;
    this.#pendingHighSurrogate = endsHigh ? pending.slice(-1) : "";
    this.bytes += Buffer.byteLength(endsHigh ? pending.slice(0, -1) : pending);
    if (!this.split) {
      this.full += value;
      if (this.full.length <= stringHeadChars + stringTailChars) return;
      this.head = this.full.slice(0, stringHeadChars);
      this.tail = this.full.slice(stringHeadChars);
      this.full = "";
      this.split = true;
    } else {
      this.tail += value;
    }
    if (this.tail.length > 2 * stringTailChars)
      this.tail = this.tail.slice(-stringTailChars);
  }
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

function decodeJsonEscape(sequence: string): string | null {
  if (sequence[1] !== "u") return SIMPLE_ESCAPES[sequence[1]!] ?? null;
  const hex = sequence.slice(2);
  return /^[0-9a-fA-F]{4}$/.test(hex)
    ? String.fromCharCode(Number.parseInt(hex, 16))
    : null;
}
