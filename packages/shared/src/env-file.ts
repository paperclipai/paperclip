import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type EnvValueEncoding = "minimal" | "json";

export type UpdateEnvFileContentsOptions = {
  valueEncoding?: EnvValueEncoding;
};

type EnvLine = {
  contents: string;
  ending: string;
};

const ENV_ASSIGNMENT_PATTERN = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;
const MINIMAL_ENV_VALUE_PATTERN = /^[A-Za-z0-9_./:@-]+$/;

export function encodeEnvValue(value: string, encoding: EnvValueEncoding = "json"): string {
  if (encoding === "minimal" && MINIMAL_ENV_VALUE_PATTERN.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function trailingEnvCommentStart(rawValue: string): number | null {
  let quote: "\"" | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < rawValue.length; index += 1) {
    const character = rawValue[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "\"" && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    // dotenv treats every unquoted # as the start of a comment, even when it
    // immediately follows the assignment separator or the value.
    if (character !== "#") continue;

    let commentStart = index;
    while (commentStart > 0 && /\s/.test(rawValue[commentStart - 1] ?? "")) {
      commentStart -= 1;
    }
    return commentStart;
  }

  return null;
}

function parseComparableEnvValue(rawValue: string): string | null {
  const commentStart = trailingEnvCommentStart(rawValue);
  const encodedValue = rawValue.slice(0, commentStart ?? rawValue.length).trim();

  if (encodedValue === "") return "";
  if (encodedValue.startsWith("\"") && encodedValue.endsWith("\"")) {
    try {
      const parsed = JSON.parse(encodedValue);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (encodedValue.startsWith("'") && encodedValue.endsWith("'")) {
    return encodedValue.slice(1, -1);
  }
  return encodedValue;
}

function splitEnvLines(contents: string): EnvLine[] {
  const lines: EnvLine[] = [];
  const newlinePattern = /\r\n|\n|\r/g;
  let lineStart = 0;
  let match: RegExpExecArray | null;

  while ((match = newlinePattern.exec(contents)) !== null) {
    lines.push({
      contents: contents.slice(lineStart, match.index),
      ending: match[0],
    });
    lineStart = newlinePattern.lastIndex;
  }

  if (lineStart < contents.length || contents.length === 0) {
    lines.push({ contents: contents.slice(lineStart), ending: "" });
  }

  return lines;
}

/**
 * Updates only the named assignments and preserves every unrelated byte.
 *
 * Duplicate managed keys are intentional: every occurrence is checked and any
 * stale occurrence is updated. Occurrences that already decode to the desired
 * value retain their original quoting and spacing.
 */
export function updateEnvFileContents(
  contents: string,
  entries: Record<string, string>,
  options: UpdateEnvFileContentsOptions = {},
): string {
  const valueEncoding = options.valueEncoding ?? "json";
  const missingEntries = new Map(Object.entries(entries));
  const lines = splitEnvLines(contents);

  for (const line of lines) {
    const match = line.contents.match(ENV_ASSIGNMENT_PATTERN);
    if (!match) continue;

    const [, prefix, key, separator, rawValue] = match;
    const value = entries[key];
    if (value === undefined) continue;

    missingEntries.delete(key);
    if (parseComparableEnvValue(rawValue) === value) continue;

    const commentStart = trailingEnvCommentStart(rawValue);
    const trailingComment = commentStart === null ? "" : rawValue.slice(commentStart);
    line.contents = `${prefix}${key}${separator}${encodeEnvValue(value, valueEncoding)}${trailingComment}`;
  }

  if (missingEntries.size > 0) {
    const newline = lines.find((line) => line.ending.length > 0)?.ending ?? "\n";
    const insertedLines = Array.from(missingEntries, ([key, value]) => ({
      contents: `${key}=${encodeEnvValue(value, valueEncoding)}`,
      ending: newline,
    }));
    const trailingBlankIndex = lines.at(-1)?.contents === "" ? lines.length - 1 : lines.length;

    if (trailingBlankIndex === lines.length && lines.length > 0) {
      const previousLine = lines.at(-1)!;
      if (previousLine.ending === "") {
        previousLine.ending = newline;
        insertedLines.at(-1)!.ending = "";
      }
    }
    lines.splice(trailingBlankIndex, 0, ...insertedLines);
  }

  return lines.map((line) => `${line.contents}${line.ending}`).join("");
}

/** Writes a changed env file through a same-directory temporary file and rename. */
export function writeEnvFileAtomicallyIfChanged(
  filePath: string,
  previousContents: string | null,
  nextContents: string,
): boolean {
  if (previousContents === nextContents) return false;

  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    fs.writeFileSync(temporaryPath, nextContents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created or may already have been renamed.
    }
    throw error;
  }

  return true;
}
