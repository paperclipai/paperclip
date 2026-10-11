export const REDACTED_SECRET_ENV_VALUE = "***REDACTED***";

// Static denylist of env var NAMES known to carry live secret material.
// A redactor must not learn its needles from a corpus of previously
// captured/leaked values (that would mean ingesting the very incident
// reports it exists to prevent). Extend this list by name only, never by
// feeding it captured secret values.
export const KNOWN_SECRET_ENV_VAR_NAMES: readonly string[] = [
  "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "PAPERCLIP_DECISION_SIGNING_SECRET",
  "PAPERCLIP_WORKSPACE_HANDOFF_SECRET",
  "PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET",
  "PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY",
  "PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY",
  "PAPERCLIP_ID_CONNECTOR_SEAL_PRIVATE_KEY",
  "PAPERCLIP_ID_CONNECTOR_SIGN_PRIVATE_KEY",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_BRIDGE_API_KEY",
  "PAPERCLIP_BRIDGE_TOKEN",
  "PAPERCLIP_GITHUB_TOKEN",
  "PAPERCLIP_GIT_TOKEN",
  "PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN",
  "PAPERCLIP_FEEDBACK_EXPORT_BACKEND_TOKEN",
  "PAPERCLIP_TELEMETRY_BACKEND_TOKEN",
  "PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN",
  "PAPERCLIP_NATIVE_MCP_TOKEN",
  "PAPERCLIP_RUNTIME_TOOLS_TOKEN",
  "PAPERCLIP_DEV_SERVER_STATUS_TOKEN",
  "PAPERCLIP_WORKSPACE_READINESS_TOKEN",
  "PAPERCLIP_AI_PROVIDER_KEY",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "OPENCODE_AUTH_JSON",
  "OPENCODE_CONFIG_CONTENT",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "CURSOR_API_KEY",
  "CODEX_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "KIMI_MODEL_API_KEY",
  "NOVITA_API_KEY",
  "DAYTONA_API_KEY",
  "E2B_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "SLACK_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "CLIENT_SECRET",
  "AWS_SESSION_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
] as const;

// A short value (e.g. "1", "true", an empty string) is too likely to appear
// coincidentally in ordinary output; redacting it would corrupt unrelated
// text for no security benefit.
const MIN_REDACTABLE_VALUE_LENGTH = 6;

export function collectKnownSecretEnvValues(
  env: Record<string, string | undefined>,
  extraNames: readonly string[] = [],
): string[] {
  const names = new Set<string>([...KNOWN_SECRET_ENV_VAR_NAMES, ...extraNames]);
  const values = new Set<string>();
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length >= MIN_REDACTABLE_VALUE_LENGTH) {
      values.add(value);
    }
  }
  // Longest first: if one denylisted value happens to be a substring of
  // another, redact the longer (more specific) match first so it isn't
  // partially consumed by the shorter one.
  return Array.from(values).sort((a, b) => b.length - a.length);
}

type RedactionRange = { from: number; to: number };

function findMergedRanges(
  text: string,
  secretValues: readonly string[],
  alreadyRedactedThrough = 0,
  retainedRanges: readonly RedactionRange[] = [],
): RedactionRange[] {
  const ranges: RedactionRange[] = [
    ...retainedRanges,
    ...(alreadyRedactedThrough > 0 ? [{ from: 0, to: alreadyRedactedThrough }] : []),
  ];
  for (const value of new Set(secretValues)) {
    if (!value) continue;
    let current: { from: number; to: number } | null = null;
    let from = text.indexOf(value);
    while (from !== -1) {
      const to = from + value.length;
      // Merge overlapping occurrences of the same value. A non-overlapping
      // replacement leaks on periodic values: replacing the first "BBBB" in
      // "BBBBB" leaves a trailing "B" that can join the next chunk's "BBB".
      if (current && from < current.to) current.to = Math.max(current.to, to);
      else {
        if (current) ranges.push(current);
        current = { from, to };
      }
      from = text.indexOf(value, from + 1);
    }
    if (current) ranges.push(current);
  }
  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    const current = merged[merged.length - 1];
    if (current && range.from < current.to) {
      current.to = Math.max(current.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

function applyRanges(
  text: string,
  ranges: readonly RedactionRange[],
  redactedValue: string,
  alreadyRedactedThrough = 0,
): string {
  let result = "";
  let plainFrom = 0;
  for (const range of ranges) {
    if (range.from >= text.length) break;
    result += text.slice(plainFrom, range.from);
    // A range continuing from a prior push already emitted its placeholder.
    if (range.from !== 0 || alreadyRedactedThrough === 0) result += redactedValue;
    plainFrom = Math.min(range.to, text.length);
  }
  return result + text.slice(plainFrom);
}

export function redactKnownSecretEnvValues(
  text: string,
  secretValues: readonly string[],
  redactedValue: string = REDACTED_SECRET_ENV_VALUE,
): string {
  if (!text || secretValues.length === 0) return text;
  return applyRanges(text, findMergedRanges(text, secretValues), redactedValue);
}

function redactControlLine(line: string, ranges: readonly RedactionRange[]): string {
  if (ranges.length === 0) return line;
  // Match Cursor's supported framing without importing an adapter into utils.
  // Validate the original payload, not display text repaired by replacement.
  const trimmed = line.trim();
  const framed = trimmed.match(/^(stdout|stderr)\s*[:=]?\s*([\[{].*)$/i);
  const payload = framed?.[2] ?? line;
  const offset = framed ? line.indexOf(trimmed) + trimmed.length - payload.length : 0;
  try {
    JSON.parse(payload);
  } catch {
    // Do not repair a malformed or clipped JSON record into a control event.
    if (/^\s*[\[{]/.test(payload)) return REDACTED_SECRET_ENV_VALUE;
    return applyRanges(line, ranges, REDACTED_SECRET_ENV_VALUE);
  }

  // A valid JSON line lets us distinguish strings from numeric tokens. Replace
  // entire affected tokens, not JSON punctuation or unquoted numeric substrings.
  // Number/string grammar: https://www.rfc-editor.org/rfc/rfc8259#section-6
  const tokens = Array.from(payload.matchAll(
    /"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
  )).map((token) => ({ text: token[0], index: token.index + offset }));
  const replacements = new Map<number, { to: number; value: string }>();
  let tokenIndex = 0;
  for (const range of ranges) {
    while (tokenIndex < tokens.length &&
      tokens[tokenIndex]!.index + tokens[tokenIndex]!.text.length <= range.from) {
      tokenIndex += 1;
    }
    const token = tokens[tokenIndex];
    const string = token?.text.startsWith('"');
    // A protected span crossing record structure cannot safely retain that
    // record. In particular, a secret containing a result line is not a result.
    if (!token || range.from < token.index + (string ? 1 : 0) ||
      range.to > token.index + token.text.length - (string ? 1 : 0)) {
      return REDACTED_SECRET_ENV_VALUE;
    }
    const keyToken = tokens[tokenIndex - 1];
    const key = keyToken?.text.startsWith('"') &&
      /^\s*:\s*$/.test(line.slice(keyToken.index + keyToken.text.length, token.index))
      ? JSON.parse(keyToken.text) as string : "";
    // A redacted price is unknown, not a genuine free/zero-cost record. Keep
    // counters parseable as before, but let cost parsers reject missing prices.
    const numericReplacement = /^(?:cost|cost_?usd|total_cost_usd|total)$/i.test(key) ? "null" : "0";
    replacements.set(token.index, {
      to: token.index + token.text.length,
      value: token.text.startsWith('"') ? JSON.stringify(REDACTED_SECRET_ENV_VALUE) : numericReplacement,
    });
  }
  let output = "";
  let from = 0;
  for (const [start, replacement] of replacements) {
    output += line.slice(from, start) + replacement.value;
    from = replacement.to;
  }
  return output + line.slice(from);
}

function redactControlText(text: string, ranges: readonly RedactionRange[], clippedLine = false): string {
  let from = 0;
  let rangeIndex = 0;
  return text.split("\n").map((line) => {
    const to = from + line.length;
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.to <= from) rangeIndex += 1;
    const lineRanges: RedactionRange[] = [];
    for (let i = rangeIndex; i < ranges.length && ranges[i]!.from < to; i += 1) {
      lineRanges.push({
        from: Math.max(0, ranges[i]!.from - from),
        to: Math.min(line.length, ranges[i]!.to - from),
      });
    }
    const output = clippedLine && from === 0 ? "" : redactControlLine(line, lineRanges);
    from = to + 1;
    return output;
  }).join("\n");
}

/** Private bounded raw scan state; callers can obtain only sanitized text. */
export function createSecretEnvRedactionScanner(secretValues: readonly string[], cap: number) {
  const values = [...new Set(secretValues)].filter(Boolean);
  const maxSecretLength = values.reduce((longest, value) => Math.max(longest, value.length), 0);
  // Any match involving the new chunk starts within this overlap of retention.
  // Scanning only the bounded tail keeps per-chunk work constant instead of
  // re-scanning the whole retained window (up to cap) on every chunk.
  const overlap = maxSecretLength > 0 ? maxSecretLength - 1 : 0;
  let retained = "";
  let coverage: RedactionRange[] = [];
  let clippedLine = false;
  return {
    append(chunk: string, inspect?: (sanitized: string) => void): void {
      const scanPrefixLength = Math.min(overlap, retained.length);
      const scanBase = retained.length - scanPrefixLength;
      let fresh: RedactionRange[] = [];
      if (values.length > 0 && (scanPrefixLength > 0 || chunk.length > 0)) {
        const scanText = retained.slice(scanBase) + chunk;
        const found = findMergedRanges(scanText, values);
        for (const range of found) {
          fresh.push({ from: range.from + scanBase, to: range.to + scanBase });
        }
      }
      // Coverage is already sorted; fresh starts at scanBase near the end, so
      // only the small tail overlapping the scan window can interact with it.
      // Merging just that tail keeps per-chunk work constant when thousands of
      // earlier matches are retained.
      let ranges: RedactionRange[];
      if (coverage.length === 0) {
        ranges = fresh;
      } else if (fresh.length === 0) {
        ranges = coverage;
      } else {
        let split = coverage.length;
        while (split > 0 && coverage[split - 1]!.to > scanBase) split -= 1;
        const tail = coverage.slice(split);
        tail.push(...fresh);
        tail.sort((a, b) => a.from - b.from || b.to - a.to);
        const mergedTail: RedactionRange[] = [];
        for (const range of tail) {
          const current = mergedTail[mergedTail.length - 1];
          if (current && range.from < current.to) {
            current.to = Math.max(current.to, range.to);
          } else {
            mergedTail.push({ ...range });
          }
        }
        ranges = coverage.slice(0, split);
        ranges.push(...mergedTail);
      }
      const candidate = retained + chunk;
      try {
        // Inspect the whole candidate before trimming, independent of log carry.
        inspect?.(redactControlText(candidate, ranges, clippedLine));
      } finally {
        const trim = Math.max(0, candidate.length - cap);
        // A retained suffix is not a new record. Keep suppressing its leading
        // fragment until retention starts at an original newline boundary.
        if (trim > 0) clippedLine = candidate[trim - 1] !== "\n";
        retained = trim === 0 ? candidate : candidate.slice(trim);
        // Coverage is evidence of a previously COMPLETE match. Keep it even if
        // clipping makes its retained suffix no longer match the original value.
        coverage = trim === 0
          ? ranges
          : ranges.filter((range) => range.to > trim).map((range) => ({
              from: Math.max(0, range.from - trim),
              to: range.to - trim,
            }));
      }
    },
    snapshot(): string {
      return redactControlText(retained, coverage, clippedLine);
    },
  };
}

export type SecretEnvRedactionStream = {
  /** Redact a chunk, holding back a bounded tail that may start a secret. */
  push(chunk: string): string;
  /** Emit whatever is still held back once the stream has ended. */
  flush(): string;
  /** Literal replacement has not removed JSON syntax-changing characters. */
  displayFallbackSafe(): boolean;
};

/**
 * Redacting each chunk independently misses a secret that straddles a chunk
 * boundary: a child writing more than one pipe buffer of output (`printenv` on
 * a large env, say) can split a value across two `data` events, and neither
 * half matches on its own, so the secret lands in the log verbatim.
 *
 * Hold back only a suffix that is a proper prefix of a secret, so safe
 * progress reaches live consumers without waiting for another chunk or EOF.
 * The held-back tail is bounded by the longest denylisted value and retains
 * existing redaction coverage for overlapping matches across chunks.
 */
export function createSecretEnvRedactionStream(
  secretValues: readonly string[],
  redactedValue: string = REDACTED_SECRET_ENV_VALUE,
): SecretEnvRedactionStream {
  const values = [...new Set(secretValues)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (values.length === 0) {
    return { push: (chunk) => chunk, flush: () => "", displayFallbackSafe: () => true };
  }

  const possiblePrefixLength = createPossibleSecretPrefixMatcher(values);

  let carry = "";
  let alreadyRedactedThrough = 0;
  let fallbackSafe = true;

  const consume = (combined: string, emitTo: number): string => {
    const ranges = findMergedRanges(combined, values, alreadyRedactedThrough);
    // Observe actual complete replacements, not unused env values. Once syntax
    // can have been removed, no display-only record from this pipe is evidence.
    if (ranges.some((range) => /["\\\u0000-\u001f]/.test(combined.slice(range.from, range.to)))) {
      fallbackSafe = false;
    }
    const output = applyRanges(
      combined.slice(0, emitTo),
      ranges,
      redactedValue,
      alreadyRedactedThrough,
    );
    // Retain raw lookbehind for future overlapping matches, plus the coverage
    // already replaced in earlier output. Re-scanning only the raw tail loses
    // that coverage and can leak a periodic secret's suffix during flush().
    const crossing = ranges.find(
      (range) => range.from < emitTo && range.to > emitTo,
    );
    carry = combined.slice(emitTo);
    if (emitTo > 0) {
      alreadyRedactedThrough = crossing ? crossing.to - emitTo : 0;
    }
    return output;
  };

  return {
    push(chunk: string): string {
      if (!chunk) return "";
      const combined = carry + chunk;
      return consume(combined, combined.length - possiblePrefixLength(combined));
    },
    flush(): string {
      return consume(carry, carry.length);
    },
    displayFallbackSafe: () => fallbackSafe,
  };
}

function createPossibleSecretPrefixMatcher(values: readonly string[]) {
  const maxSecretLength = Math.max(1, ...values.map((value) => value.length));
  const matchers = values.map((value) => {
    const fallback = new Array<number>(value.length).fill(0);
    for (let i = 1, matched = 0; i < value.length; i += 1) {
      while (matched > 0 && value[i] !== value[matched]) {
        matched = fallback[matched - 1]!;
      }
      if (value[i] === value[matched]) matched += 1;
      fallback[i] = matched;
    }
    return { value, fallback };
  });

  const possiblePrefixLength = (text: string): number => {
    let longest = 0;
    // Only this bounded tail can contain an incomplete match. Prefix fallback
    // tables keep repeated-character secrets from requiring quadratic scans.
    const from = Math.max(0, text.length - (maxSecretLength - 1));
    for (const { value, fallback } of matchers) {
      let matched = 0;
      for (let i = from; i < text.length; i += 1) {
        while (matched > 0 && text[i] !== value[matched]) {
          matched = fallback[matched - 1]!;
        }
        if (text[i] === value[matched]) matched += 1;
        if (matched === value.length) matched = fallback[matched - 1]!;
      }
      longest = Math.max(longest, matched);
    }
    return longest;
  };

  return possiblePrefixLength;
}

/** Ordered stable control records; never emit a clipped record as a new event. */
export function createSecretEnvRedactionControlStream(secretValues: readonly string[], cap: number) {
  const values = [...new Set(secretValues)].filter(Boolean);
  const maxSecretLength = values.reduce((longest, value) => Math.max(longest, value.length), 0);
  // Incremental carry: only the bounded tail plus the new chunk can hold a
  // match that is not already covered, so per-chunk scanning stays constant.
  const overlap = maxSecretLength > 0 ? maxSecretLength - 1 : 0;
  const possiblePrefixLength = createPossibleSecretPrefixMatcher(values);
  let pending = "";
  let coverage: RedactionRange[] = [];
  let clippedLine = false;

  const consume = (chunk: string, eof: boolean): string => {
    const scanPrefixLength = Math.min(overlap, pending.length);
    const scanBase = pending.length - scanPrefixLength;
    let fresh: RedactionRange[] = [];
    if (values.length > 0 && (scanPrefixLength > 0 || chunk.length > 0)) {
      const scanText = pending.slice(scanBase) + chunk;
      const found = findMergedRanges(scanText, values);
      for (const range of found) {
        fresh.push({ from: range.from + scanBase, to: range.to + scanBase });
      }
    }
    let ranges: RedactionRange[];
    if (coverage.length === 0) {
      ranges = fresh;
    } else if (fresh.length === 0) {
      ranges = coverage;
    } else {
      let split = coverage.length;
      while (split > 0 && coverage[split - 1]!.to > scanBase) split -= 1;
      const tail = coverage.slice(split);
      tail.push(...fresh);
      tail.sort((a, b) => a.from - b.from || b.to - a.to);
      const mergedTail: RedactionRange[] = [];
      for (const range of tail) {
        const current = mergedTail[mergedTail.length - 1];
        if (current && range.from < current.to) {
          current.to = Math.max(current.to, range.to);
        } else {
          mergedTail.push({ ...range });
        }
      }
      ranges = coverage.slice(0, split);
      ranges.push(...mergedTail);
    }
    const candidate = pending + chunk;
    const stableEnd = eof ? candidate.length : candidate.length - possiblePrefixLength(candidate);
    const end = eof ? stableEnd : (stableEnd > 0 ? candidate.lastIndexOf("\n", stableEnd - 1) + 1 : 0);
    const firstLineEnd = clippedLine ? candidate.indexOf("\n") + 1 : 0;
    const from = clippedLine ? (firstLineEnd || end) : 0;
    const output = end > from ? redactControlText(candidate.slice(from, end), ranges
      .filter((range) => range.to > from && range.from < end)
      .map((range) => ({ from: Math.max(0, range.from - from), to: Math.min(end, range.to) - from }))) : "";
    if (clippedLine && firstLineEnd > 0 && firstLineEnd <= end) clippedLine = false;
    // A pending cross-record secret prefix must survive even when it is longer
    // than the record cap. Like display carry, it is bounded by the longest value.
    const retain = Math.max(cap, candidate.length - stableEnd);
    const trim = Math.max(end, candidate.length - retain);
    if (trim > end) clippedLine = candidate[trim - 1] !== "\n";
    pending = candidate.slice(trim);
    coverage = ranges.filter((range) => range.to > trim).map((range) => ({
      from: Math.max(0, range.from - trim), to: range.to - trim,
    }));
    return output;
  };

  return {
    push: (chunk: string) => consume(chunk, false),
    flush: () => consume("", true),
  };
}
