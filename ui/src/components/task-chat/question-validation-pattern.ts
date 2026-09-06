export type QuestionValidationPatternResult =
  | "match"
  | "no_match"
  | "unsupported";

const MAX_SAFE_PATTERN_LENGTH = 256;
const UNSUPPORTED_PATTERN_TOKENS = new Set([
  "(",
  ")",
  "{",
  "}",
  "*",
  "+",
  "?",
  "|",
  "^",
  "$",
]);

type CharacterMatcher = (character: string) => boolean;

function escapedMatcher(token: string): CharacterMatcher {
  if (token === "d")
    return (character) => character >= "0" && character <= "9";
  if (token === "D") return (character) => character < "0" || character > "9";
  if (token === "w")
    return (character) =>
      (character >= "0" && character <= "9") ||
      (character >= "A" && character <= "Z") ||
      (character >= "a" && character <= "z") ||
      character === "_";
  if (token === "W") {
    const word = escapedMatcher("w");
    return (character) => !word(character);
  }
  if (token === "s")
    return (character) => " \t\n\r\f\v".includes(character);
  if (token === "S") {
    const whitespace = escapedMatcher("s");
    return (character) => !whitespace(character);
  }
  return (character) => character === token;
}

function classMatcher(
  source: string,
  start: number,
): { matcher: CharacterMatcher; next: number } | null {
  let cursor = start;
  const negated = source[cursor] === "^";
  if (negated) cursor += 1;
  const ranges: Array<[number, number]> = [];

  const readCharacter = (): string | null => {
    if (cursor >= source.length || source[cursor] === "]") return null;
    const current = source[cursor++]!;
    if (current !== "\\") return current;
    if (cursor >= source.length) return null;
    const escaped = source[cursor++]!;
    // Character-class escapes with semantic expansion would make range
    // parsing ambiguous. Fail closed; escaped punctuation remains literal.
    if ("dDsSwW".includes(escaped)) return null;
    return escaped;
  };

  while (cursor < source.length && source[cursor] !== "]") {
    const first = readCharacter();
    if (first === null) return null;
    if (
      source[cursor] === "-" &&
      cursor + 1 < source.length &&
      source[cursor + 1] !== "]"
    ) {
      cursor += 1;
      const last = readCharacter();
      if (last === null || first.charCodeAt(0) > last.charCodeAt(0))
        return null;
      ranges.push([first.charCodeAt(0), last.charCodeAt(0)]);
    } else {
      ranges.push([first.charCodeAt(0), first.charCodeAt(0)]);
    }
  }
  if (source[cursor] !== "]" || ranges.length === 0) return null;
  const next = cursor + 1;
  return {
    next,
    matcher: (character) => {
      const code = character.charCodeAt(0);
      const included = ranges.some(
        ([first, last]) => code >= first && code <= last,
      );
      return negated ? !included : included;
    },
  };
}

/**
 * Evaluate a deliberately small, fixed-width subset of regular-expression
 * syntax without invoking JavaScript's backtracking RegExp engine. Provider
 * patterns outside this subset fail closed instead of reaching the UI thread.
 */
export function matchSafeQuestionValidationPattern(
  pattern: string,
  value: string,
): QuestionValidationPatternResult {
  if (
    pattern.length < 2 ||
    pattern.length > MAX_SAFE_PATTERN_LENGTH ||
    !pattern.startsWith("^") ||
    !pattern.endsWith("$")
  ) {
    return "unsupported";
  }

  const source = pattern.slice(1, -1);
  const matchers: CharacterMatcher[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const token = source[cursor++]!;
    if (UNSUPPORTED_PATTERN_TOKENS.has(token)) return "unsupported";
    if (token === "[") {
      const parsed = classMatcher(source, cursor);
      if (!parsed) return "unsupported";
      matchers.push(parsed.matcher);
      cursor = parsed.next;
      continue;
    }
    if (token === "]") return "unsupported";
    if (token === "\\") {
      if (cursor >= source.length) return "unsupported";
      matchers.push(escapedMatcher(source[cursor++]!));
      continue;
    }
    if (token === ".") {
      matchers.push(
        (character) => !["\n", "\r", "\u2028", "\u2029"].includes(character),
      );
      continue;
    }
    matchers.push((character) => character === token);
  }

  if (value.length !== matchers.length) return "no_match";
  return matchers.every((matcher, index) => matcher(value[index]!))
    ? "match"
    : "no_match";
}
