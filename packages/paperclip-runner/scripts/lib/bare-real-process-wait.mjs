import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const libraryDirectory = fileURLToPath(new URL(".", import.meta.url));
export const defaultPackageRoot = resolve(libraryDirectory, "../..");

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx"]);

// A wait against a spawned operating-system process can run far longer than
// vitest's default `vi.waitFor` or `expect.poll` deadline (see the helper
// and its evidence comment in test/wait-for-live-process.ts). A wait that
// settles fully in-process never needs that deadline, so this check does
// not force every wait onto the real-process helper — it only requires that
// a bare call in this directory carries an explicit note that the wait
// settles in-process, or an explicit `timeout` option that states its own
// envelope.
const IN_PROCESS_WAIT_MARKER = "bare-wait-ok:";

// `expect.poll(` can span two lines as `expect\n  .poll(`, so each pattern
// allows whitespace (including a newline) around the dot.
const BARE_WAIT_PATTERNS = [
  { name: "vi.waitFor(", regex: /\bvi\s*\.\s*waitFor\(/g },
  { name: "expect.poll(", regex: /\bexpect\s*\.\s*poll\(/g },
];

const EXPLICIT_TIMEOUT_PATTERN = /\btimeout\s*:/;

function extension(path) {
  const match = path.match(/\.[^./\\]+$/);
  return match?.[0] ?? "";
}

async function collectSourceFiles(target) {
  const entries = await readdir(target, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (["dist", "node_modules", ".git"].includes(entry.name)) {
      continue;
    }
    const path = resolve(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(path)));
    } else if (entry.isFile() && SCANNED_EXTENSIONS.has(extension(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

// Report whether the `/` at `source[index]` most likely opens a regex
// literal rather than divides two values. This looks at the last non-space
// character before `index`: an identifier, a number, or a `)`/`]` that
// closes a value means `/` divides, unless that identifier is a keyword
// (`return`, `typeof`, `case`, and so on) that itself expects an expression
// next. Anything else — an operator, an opening bracket, the start of the
// scanned text, or none of the above — means `/` opens a regex literal.
// This is the same ambiguity a full JavaScript parser resolves with grammar
// state; this heuristic only needs to hold for the code this guard scans.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "yield", "case", "throw", "do", "else", "await",
]);

// A word that reads as one of `REGEX_PRECEDING_KEYWORDS` is a property
// name, not the keyword, when a `.` (a plain member access or the last
// character of an optional-chain `?.`) sits directly before it, with only
// space allowed in between. `obj.await` is a value, so the `/` right after
// it divides; only a standalone `await` puts the `/` in an expression
// position.
function isKeywordShapedPropertyName(source, wordStartIndex) {
  let beforeWordIndex = wordStartIndex - 1;
  while (beforeWordIndex >= 0 && /\s/.test(source[beforeWordIndex])) {
    beforeWordIndex -= 1;
  }
  return beforeWordIndex >= 0 && source[beforeWordIndex] === ".";
}

function isRegexLiteralStart(source, index) {
  let previousIndex = index - 1;
  while (previousIndex >= 0 && /\s/.test(source[previousIndex])) {
    previousIndex -= 1;
  }
  if (previousIndex < 0) return true;
  const previousCharacter = source[previousIndex];
  if (!/[\w$)\]]/.test(previousCharacter)) return true;
  const wordMatch = source.slice(0, previousIndex + 1).match(/[A-Za-z_$][\w$]*$/);
  const word = wordMatch?.[0] ?? "";
  if (!REGEX_PRECEDING_KEYWORDS.has(word)) return false;
  const wordStartIndex = previousIndex + 1 - word.length;
  if (isKeywordShapedPropertyName(source, wordStartIndex)) return false;
  return true;
}

// Mask a `/pattern/flags` regex literal, starting at the opening `/` in
// `source[start]`, with spaces up to and including its trailing flags. A
// `{`, `}`, `(`, `)`, `[`, or `]` inside the pattern is part of the regex,
// not executable-code structure, so masking the whole literal — the same
// way a string literal is masked — keeps it from changing brace depth or
// confusing paren matching. A `/` inside a `[...]` character class does not
// close the literal.
function maskRegexLiteral(source, masked, start, end) {
  let index = start;
  masked[index] = " ";
  index += 1;
  let inCharacterClass = false;
  while (index < end) {
    const character = source[index];
    if (character === "\n") return index;
    if (character === "\\" && index + 1 < end) {
      masked[index] = " ";
      index += 1;
      if (source[index] !== "\n") masked[index] = " ";
      index += 1;
      continue;
    }
    if (character === "[") inCharacterClass = true;
    if (character === "]") inCharacterClass = false;
    masked[index] = " ";
    index += 1;
    if (character === "/" && !inCharacterClass) {
      while (index < end && /[a-zA-Z]/.test(source[index])) {
        masked[index] = " ";
        index += 1;
      }
      return index;
    }
  }
  return index;
}

// Scan `source` from `start` up to `end` as executable code, writing spaces
// into `masked` for each comment, each regex literal, and each string- or
// template-literal quote character it finds, then handing the literal body
// to `maskLiteralBody`. Every other character stays as it is in `source`, so
// a wait-call pattern written as real code — including inside a template's
// `${...}` expression — still matches once masking is done. When
// `stopAtOwnCloseBrace` is true, `start` points just past a `${` this
// function did not consume, and the function tracks nested `{`/`}` pairs so
// it returns right after the `}` that closes this same interpolation,
// leaving both braces unmasked. Masking a regex literal whole, before this
// tracking sees any of its characters, keeps a brace inside the regex from
// changing that count.
function maskCode(source, masked, start, end, stopAtOwnCloseBrace) {
  let index = start;
  let braceDepth = stopAtOwnCloseBrace ? 1 : 0;
  while (index < end) {
    const twoCharacters = source.slice(index, index + 2);
    const character = source[index];
    if (twoCharacters === "//") {
      while (index < end && source[index] !== "\n") {
        masked[index] = " ";
        index += 1;
      }
      continue;
    }
    if (twoCharacters === "/*") {
      masked[index] = " ";
      masked[index + 1] = " ";
      index += 2;
      while (index < end && source.slice(index, index + 2) !== "*/") {
        if (source[index] !== "\n") masked[index] = " ";
        index += 1;
      }
      if (index < end) {
        masked[index] = " ";
        masked[index + 1] = " ";
        index += 2;
      }
      continue;
    }
    if (character === "/" && isRegexLiteralStart(source, index)) {
      index = maskRegexLiteral(source, masked, index, end);
      continue;
    }
    if (character === "'" || character === '"') {
      masked[index] = " ";
      index = maskLiteralBody(source, masked, index + 1, end, character, false);
      continue;
    }
    if (character === "`") {
      masked[index] = " ";
      index = maskLiteralBody(source, masked, index + 1, end, character, true);
      continue;
    }
    if (stopAtOwnCloseBrace && character === "{") {
      braceDepth += 1;
      index += 1;
      continue;
    }
    if (stopAtOwnCloseBrace && character === "}") {
      braceDepth -= 1;
      index += 1;
      if (braceDepth === 0) return index;
      continue;
    }
    index += 1;
  }
  return index;
}

// Mask a `'`/`"` string body, or the literal-text runs of a backtick
// template, with spaces up to and including the matching `quote`. This
// keeps `masked` the same length and the same line breaks as `source`, so a
// pattern written as plain text inside the literal can never survive into
// the result. For a template literal (`isTemplate` is true), a `${` inside
// the body hands control to `maskCode` instead, so the interpolation is
// scanned as executable code, not masked as text; masking of literal text
// resumes on the matching `}` that `maskCode` returns.
function maskLiteralBody(source, masked, start, end, quote, isTemplate) {
  let index = start;
  while (index < end) {
    const character = source[index];
    if (character === quote) {
      masked[index] = " ";
      return index + 1;
    }
    if (character === "\\" && index + 1 < end) {
      masked[index] = " ";
      index += 1;
      if (source[index] !== "\n") masked[index] = " ";
      index += 1;
      continue;
    }
    if (isTemplate && character === "$" && source[index + 1] === "{") {
      index += 2;
      index = maskCode(source, masked, index, end, true);
      continue;
    }
    if (character !== "\n") masked[index] = " ";
    index += 1;
  }
  return index;
}

// Replace every comment and every string- or template-literal body with
// spaces, one for one, so the result keeps the same length and the same
// line breaks as `source`. A line count taken from the result still lines
// up with `source`, and neither a wait-call pattern nor a `timeout` option
// written inside a comment or plain literal text can survive into the
// result. A wait-call pattern written inside a template's `${...}`
// expression is executable code, so it survives masking and is still
// scanned, the same as a call written outside any literal.
function maskCommentsAndStrings(source) {
  const masked = source.split("");
  maskCode(source, masked, 0, source.length, false);
  return masked.join("");
}

// Find the index of the close paren that matches the open paren at
// `openParenIndex`, tracking nested `()`, `{}`, and `[]`. Callers pass a
// comment- and string-masked source, so a stray bracket inside a comment or
// a literal never throws off the count.
function findMatchingCloseParenIndex(maskedSource, openParenIndex) {
  let depth = 0;
  for (let index = openParenIndex; index < maskedSource.length; index += 1) {
    const character = maskedSource[index];
    if (character === "(" || character === "{" || character === "[") {
      depth += 1;
    } else if (character === ")" || character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return maskedSource.length;
}

// Split a call's argument-list text on its top-level commas, so a comma
// nested inside a callback body, an object, or an array does not split a
// single argument in two.
function splitTopLevelArguments(maskedCallArguments) {
  const args = [];
  let depth = 0;
  let current = "";
  for (const character of maskedCallArguments) {
    if (character === "(" || character === "{" || character === "[") {
      depth += 1;
      current += character;
    } else if (character === ")" || character === "}" || character === "]") {
      depth -= 1;
      current += character;
    } else if (character === "," && depth === 0) {
      args.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  args.push(current);
  return args;
}

// Return the wait call's own options argument (`vi.waitFor(callback,
// options)` or `expect.poll(callback, options)`), or `null` when the call
// passes no second argument. Only this text, not the callback body, states
// the call's own timeout.
function findOptionsArgument(maskedSource, openParenIndex, closeParenIndex) {
  const callArguments = maskedSource.slice(openParenIndex + 1, closeParenIndex);
  const topLevelArguments = splitTopLevelArguments(callArguments);
  return topLevelArguments.length >= 2 ? topLevelArguments[1] : null;
}

/**
 * Find each real-process-shaped wait call (`vi.waitFor(`, or `expect.poll(`,
 * including the two-line `expect\n  .poll(` form) in `source` that has
 * neither an `IN_PROCESS_WAIT_MARKER` note on the line directly above it
 * nor an explicit `timeout` option in its own options argument. A call site
 * with the marker declares, in place, that it settles fully in-process. A
 * call site with an explicit `timeout` option already states its own
 * envelope. Either one needs no real-process deadline. A pattern written
 * inside a comment or inside a string or template literal is source text,
 * not a call, and never counts as one.
 */
export function findBareRealProcessWaits(source) {
  const lines = source.split("\n");
  const masked = maskCommentsAndStrings(source);
  const found = [];
  for (const { name, regex } of BARE_WAIT_PATTERNS) {
    regex.lastIndex = 0;
    for (
      let match = regex.exec(masked);
      match !== null;
      match = regex.exec(masked)
    ) {
      const line = masked.slice(0, match.index).split("\n").length;
      const precedingLine = lines[line - 2] ?? "";
      if (precedingLine.includes(IN_PROCESS_WAIT_MARKER)) {
        continue;
      }
      const openParenIndex = match.index + match[0].length - 1;
      const closeParenIndex = findMatchingCloseParenIndex(masked, openParenIndex);
      const optionsArgument = findOptionsArgument(masked, openParenIndex, closeParenIndex);
      if (optionsArgument !== null && EXPLICIT_TIMEOUT_PATTERN.test(optionsArgument)) {
        continue;
      }
      found.push({ line, pattern: name });
    }
  }
  found.sort((a, b) => a.line - b.line);
  return found;
}

export async function checkBareRealProcessWaits({
  packageRoot = defaultPackageRoot,
  scanRoot = "src/live",
} = {}) {
  const root = resolve(packageRoot, scanRoot);
  const files = (await collectSourceFiles(root)).sort();
  const violations = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const { line, pattern } of findBareRealProcessWaits(source)) {
      violations.push({ file, line, pattern });
    }
  }
  return violations;
}

export function formatBareRealProcessWaitViolation(violation, packageRoot = defaultPackageRoot) {
  return (
    `${relative(packageRoot, violation.file)}:${violation.line} calls a bare ${violation.pattern}: ` +
    "use waitForCapabilityLiveProcess (test/wait-for-live-process.ts) for a wait bound to a real " +
    "spawned process, mark a wait that settles fully in-process with a comment containing " +
    `"${IN_PROCESS_WAIT_MARKER}" on the line above the call, or pass an explicit timeout option ` +
    "that states the wait's own envelope"
  );
}
