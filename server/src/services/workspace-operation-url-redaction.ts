const URL_PREFIX_RE = /[a-z][a-z0-9+.-]{0,31}:\/\//gi;
const PARTIAL_URL_PREFIX_RE = /[a-z][a-z0-9+.-]{0,31}(?::\/?)?(?![\s\S])/i;
const URL_BOUNDARY_RE = /[@\s/\\"?#<>]/;
const TRUNCATED_OUTPUT_PREFIX_RE = /^\[output truncated to last \d+ bytes; total \d+ bytes\]\n/;
const TRUNCATED_OUTPUT_RAW_PREFIX_RE = /^\[output truncated to last \d+ bytes; total \d+ bytes\]\\n/;
const MAX_PREFIX_LENGTH = 35;
const MAX_PENDING_USERINFO_LENGTH = 8192;
const REDACTED_USERINFO = "[REDACTED]";

/** Redact URL userinfo in operation fields and complete output strings. */
export function redactWorkspaceOperationUrlUserInfo(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/\\"?#<>@]+)@/gi, `$1${REDACTED_USERINFO}@`);
}

/** A bounded process capture can start inside userinfo, before the URL scheme. */
export function redactTruncatedWorkspaceOperationOutput(value: string): string {
  const prefix = TRUNCATED_OUTPUT_PREFIX_RE.exec(value)?.[0];
  if (!prefix) return value;
  const tail = value.slice(prefix.length);
  const end = /[@\s"<>]/.exec(tail)?.index ?? tail.length;
  if (end === 0) return value;
  // The preceding bytes were discarded, so this first token cannot be classified safely.
  return prefix + REDACTED_USERINFO + tail.slice(end);
}

/** An old 4096-character excerpt may start in the middle of URL userinfo. */
export function redactWorkspaceOperationExcerpt(value: string | null): string | null {
  if (value === null) return null;
  return redactWorkspaceOperationUrlUserInfo(redactTruncatedWorkspaceOperationOutput(value))
    .replace(/([^\s/@]+)@(?=(?:\[[^\]\s/?#@]+\]|[a-z0-9.-]+)?(?::\d+)?(?:[/?#\s"'<>;,}]|$))/gi, `${REDACTED_USERINFO}@`);
}

export function redactWorkspaceOperationUrls<T>(value: T): T {
  if (typeof value === "string") return redactWorkspaceOperationUrlUserInfo(value) as T;
  if (Array.isArray(value)) return value.map(redactWorkspaceOperationUrls) as T;
  if (value instanceof Date || value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactWorkspaceOperationUrls(entry)]),
  ) as T;
}

/**
 * The replacement keeps every byte position stable for the byte-range log API.
 * Latin-1 maps each input byte to one character, including UTF-8 bytes around URLs.
 */
export function maskWorkspaceOperationUrlUserInfoBytes(input: Buffer): Buffer {
  const output = Buffer.from(input);
  const text = input.toString("latin1");
  const pattern = /[a-z][a-z0-9+.-]{0,31}:\/\/([^\s/\\"?#<>@]+)@/gi;
  for (const match of text.matchAll(pattern)) {
    const userinfoStart = match.index + match[0].indexOf("://") + 3;
    output.fill(0x2a, userinfoStart, userinfoStart + match[1]!.length);
  }
  return output;
}

export interface WorkspaceOperationMaskedByteRange {
  start: number;
  end: number;
}

/**
 * Find byte positions to hide in old NDJSON logs. The same stream may continue
 * a URL in a later event, with JSON metadata between the two chunk strings.
 * Only positions are retained; no credential value is cached.
 */
export function createWorkspaceOperationByteRangeScanner() {
  type State = { pending: string; positions: number[]; droppingUserInfo: boolean };
  const states = new Map<string, State>();
  const ranges: WorkspaceOperationMaskedByteRange[] = [];

  function mark(positions: number[]) {
    for (const position of positions) {
      const last = ranges[ranges.length - 1];
      if (last && last.end === position) last.end += 1;
      else ranges.push({ start: position, end: position + 1 });
    }
  }

  function drain(state: State) {
    while (state.pending) {
      if (state.droppingUserInfo) {
        const boundary = URL_BOUNDARY_RE.exec(state.pending)?.index ?? -1;
        const count = boundary < 0 ? state.pending.length : boundary;
        mark(state.positions.slice(0, count));
        state.pending = state.pending.slice(boundary < 0 ? count : count + 1);
        state.positions = state.positions.slice(boundary < 0 ? count : count + 1);
        if (boundary < 0) return;
        state.droppingUserInfo = false;
        continue;
      }

      URL_PREFIX_RE.lastIndex = 0;
      const match = URL_PREFIX_RE.exec(state.pending);
      if (!match) {
        const keep = Math.min(MAX_PREFIX_LENGTH - 1, state.pending.length);
        state.pending = state.pending.slice(state.pending.length - keep);
        state.positions = state.positions.slice(state.positions.length - keep);
        return;
      }

      state.pending = state.pending.slice(match.index);
      state.positions = state.positions.slice(match.index);
      const userinfoStart = match[0].length;
      const suffix = state.pending.slice(userinfoStart);
      const boundary = URL_BOUNDARY_RE.exec(suffix)?.index ?? -1;
      if (boundary >= 0) {
        if (suffix[boundary] === "@" && boundary > 0) {
          mark(state.positions.slice(userinfoStart, userinfoStart + boundary));
        }
        const consumed = userinfoStart + boundary + 1;
        state.pending = state.pending.slice(consumed);
        state.positions = state.positions.slice(consumed);
        continue;
      }

      if (suffix.length > MAX_PENDING_USERINFO_LENGTH) {
        mark(state.positions.slice(userinfoStart));
        state.pending = "";
        state.positions = [];
        state.droppingUserInfo = true;
      }
      return;
    }
  }

  return {
    feed(stream: string, rawChunk: string, byteOffset: number) {
      const state = states.get(stream) ?? { pending: "", positions: [], droppingUserInfo: false };
      states.set(stream, state);
      const truncatedPrefix = TRUNCATED_OUTPUT_RAW_PREFIX_RE.exec(rawChunk)?.[0];
      if (truncatedPrefix) {
        const tail = rawChunk.slice(truncatedPrefix.length);
        const end = /[@\\\s"<>]/.exec(tail)?.index ?? tail.length;
        if (end > 0) {
          ranges.push({
            start: byteOffset + truncatedPrefix.length,
            end: byteOffset + truncatedPrefix.length + end,
          });
        }
      }
      for (let start = 0; start < rawChunk.length; start += 8192) {
        const part = rawChunk.slice(start, start + 8192);
        state.pending += part;
        for (let i = 0; i < part.length; i += 1) state.positions.push(byteOffset + start + i);
        drain(state);
      }
    },
    finish(): WorkspaceOperationMaskedByteRange[] {
      for (const state of states.values()) {
        if (state.droppingUserInfo) continue;
        URL_PREFIX_RE.lastIndex = 0;
        const match = URL_PREFIX_RE.exec(state.pending);
        if (match) mark(state.positions.slice(match.index + match[0].length));
      }
      ranges.sort((left, right) => left.start - right.start);
      const merged: WorkspaceOperationMaskedByteRange[] = [];
      for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && last.end >= range.start) last.end = Math.max(last.end, range.end);
        else merged.push({ ...range });
      }
      return merged;
    },
  };
}

/** Hold a possible URL until the @ or URL boundary arrives in a later chunk. */
export function createWorkspaceOperationUrlStreamRedactor() {
  let pending = "";
  let droppingUserInfo = false;

  function consume(chunk: string, final = false): string {
    let input = pending + chunk;
    pending = "";
    let output = "";

    if (droppingUserInfo) {
      const boundary = URL_BOUNDARY_RE.exec(input)?.index ?? -1;
      if (boundary < 0) return output;
      output += input[boundary] === "@" ? "@" : input[boundary];
      input = input.slice(boundary + 1);
      droppingUserInfo = false;
    }

    while (input) {
      URL_PREFIX_RE.lastIndex = 0;
      const match = URL_PREFIX_RE.exec(input);
      if (!match) {
        // Keep only a suffix that could become a URL scheme in the next chunk.
        // Holding an arbitrary tail would split ordinary complete log lines.
        const keep = final ? 0 : (PARTIAL_URL_PREFIX_RE.exec(input)?.[0].length ?? 0);
        output += input.slice(0, input.length - keep);
        pending = input.slice(input.length - keep);
        break;
      }

      output += input.slice(0, match.index);
      const prefix = match[0];
      const afterPrefix = input.slice(match.index + prefix.length);
      const end = URL_BOUNDARY_RE.exec(afterPrefix)?.index ?? -1;
      if (end < 0) {
        if (final) {
          // An interrupted stream may end inside userinfo, before its @ arrives.
          output += prefix + (afterPrefix ? REDACTED_USERINFO : "");
        } else if (afterPrefix.length > MAX_PENDING_USERINFO_LENGTH) {
          output += prefix + REDACTED_USERINFO;
          droppingUserInfo = true;
        } else {
          pending = prefix + afterPrefix;
        }
        break;
      }

      if (afterPrefix[end] === "@" && end > 0) {
        output += prefix + REDACTED_USERINFO + "@";
      } else {
        output += prefix + afterPrefix.slice(0, end + 1);
      }
      input = afterPrefix.slice(end + 1);
    }
    return output;
  }

  return {
    push: (chunk: string) => consume(chunk),
    flush: () => consume("", true),
    hasPending: () => pending.length > 0 || droppingUserInfo,
  };
}
