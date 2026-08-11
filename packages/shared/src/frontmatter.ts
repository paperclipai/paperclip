import { z } from "zod";

export interface MarkdownDoc {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

export interface FrontmatterBlock {
  frontmatterText: string;
  body: string;
  hasFrontmatter: boolean;
}

export type FrontmatterRoundTripIssueKind =
  | "anchor"
  | "alias"
  | "comment"
  | "quoted_key"
  | "tag";

export interface FrontmatterRoundTripIssue {
  kind: FrontmatterRoundTripIssueKind;
  line: number;
  column: number;
  message: string;
}

const SKILL_FRONTMATTER_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUPPORTED_FRONTMATTER_KEY_RE = /^[A-Za-z0-9_. -]+$/;

type SerializableFrontmatterValue =
  | null
  | string
  | number
  | boolean
  | SerializableFrontmatterValue[]
  | { [key: string]: SerializableFrontmatterValue };

const skillMetadataValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(skillMetadataValueSchema),
    z.record(skillMetadataValueSchema),
  ])
);

export const skillFrontmatterSchema = z.object({
  name: z.string().regex(SKILL_FRONTMATTER_SLUG_RE, "Expected a lowercase URL slug."),
  description: z.string().min(1),
  "allowed-tools": z.array(z.string()).optional(),
  metadata: z.record(skillMetadataValueSchema).optional(),
}).passthrough();

export const skillFrontmatterKnownKeys = [
  "name",
  "description",
  "allowed-tools",
  "metadata",
] as const;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function asStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;

  const out: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (!text) return null;
    out.push(text);
  }
  return out;
}

export function splitFrontmatterBlock(raw: string): FrontmatterBlock {
  if (!raw.startsWith("---\n")) {
    return { frontmatterText: "", body: raw, hasFrontmatter: false };
  }

  const closing = raw.indexOf("\n---\n", 3);
  if (closing < 0) {
    return { frontmatterText: "", body: raw, hasFrontmatter: false };
  }

  return {
    frontmatterText: raw.slice(4, closing),
    body: raw.slice(closing + 5),
    hasFrontmatter: true,
  };
}

export function stringifyFrontmatter(value: Record<string, unknown>): string {
  return stringifyYamlRecord(assertSerializableRecord(value), 0).join("\n");
}

export function getSkillFrontmatterUnknownKeys(value: Record<string, unknown>) {
  const known = new Set<string>(skillFrontmatterKnownKeys);
  return Object.keys(value).filter((key) => !known.has(key));
}

export function detectFrontmatterRoundTripIssues(rawYaml: string): FrontmatterRoundTripIssue[] {
  const issues: FrontmatterRoundTripIssue[] = [];
  const lines = rawYaml.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const contentStart = line.search(/\S/u);
    if (contentStart < 0) continue;

    const content = line.slice(contentStart);
    if (content.startsWith("#")) {
      issues.push({
        kind: "comment",
        line: index + 1,
        column: contentStart + 1,
        message: "Comments are not preserved by the frontmatter field serializer.",
      });
      continue;
    }

    const inlineComment = findRoundTripPattern(line, /(^|\s)#/u);
    if (inlineComment >= 0) {
      issues.push({
        kind: "comment",
        line: index + 1,
        column: inlineComment + 1,
        message: "Inline comments are not preserved by the frontmatter field serializer.",
      });
    }

    const quotedKey = /^\s*(?:-\s*)?(["']).+?\1\s*:/u.exec(line);
    if (quotedKey) {
      issues.push({
        kind: "quoted_key",
        line: index + 1,
        column: line.indexOf(quotedKey[1]!) + 1,
        message: "Quoted YAML keys cannot be round-tripped by the frontmatter parser.",
      });
    }

    const anchor = findRoundTripPattern(line, /(^|[\s,[{])&[A-Za-z0-9_-]+/u);
    if (anchor >= 0) {
      issues.push({
        kind: "anchor",
        line: index + 1,
        column: anchor + 1,
        message: "YAML anchors cannot be round-tripped by the frontmatter parser.",
      });
    }

    const alias = findRoundTripPattern(line, /(^|[\s,[{])\*[A-Za-z0-9_-]+/u);
    if (alias >= 0) {
      issues.push({
        kind: "alias",
        line: index + 1,
        column: alias + 1,
        message: "YAML aliases cannot be round-tripped by the frontmatter parser.",
      });
    }

    const tag = findRoundTripPattern(line, /(^|\s)![A-Za-z!][^\s]*/u);
    if (tag >= 0) {
      issues.push({
        kind: "tag",
        line: index + 1,
        column: tag + 1,
        message: "YAML tags cannot be round-tripped by the frontmatter parser.",
      });
    }
  }

  return issues;
}

/**
 * Recombine a split block into a full markdown document. This is the exact
 * inverse of {@link splitFrontmatterBlock}: `join(split(x)) === x` for every
 * input, so opening a file and saving it untouched is byte-identical. The body
 * is passed through verbatim — never re-parsed or re-serialized.
 */
export function joinFrontmatterBlock(block: FrontmatterBlock): string {
  if (!block.hasFrontmatter) return block.body;
  return `---\n${block.frontmatterText}\n---\n${block.body}`;
}

/**
 * Parse the raw YAML of a frontmatter block (the text between the `---` fences,
 * as returned by {@link splitFrontmatterBlock}) into a plain object. Lenient:
 * unparseable input yields `{}` rather than throwing.
 */
export function parseFrontmatterFields(frontmatterText: string): Record<string, unknown> {
  return parseYamlFrontmatter(frontmatterText);
}

export interface FrontmatterAnalysis {
  /** The parsed field object (best-effort; `{}` when nothing parses). */
  parsed: Record<string, unknown>;
  /**
   * True when the field editor is safe to use: the raw YAML both parses and
   * re-serializes byte-for-byte. When false, editing must stay in raw-YAML mode
   * so bytes the serializer can't reproduce (comments, anchors, folded scalars,
   * custom ordering, quoting) are never silently rewritten.
   */
  canRoundTrip: boolean;
  /** Structural features that make the block non-round-trippable, if any. */
  issues: FrontmatterRoundTripIssue[];
}

/**
 * Decide whether a frontmatter block can be edited through the structured
 * field form. Fields mode is only offered when re-serializing the parsed object
 * reproduces the original block exactly — this is the load-bearing round-trip
 * safety gate for the Skill Studio FrontmatterPanel (PAP-13145 Option B).
 */
export function analyzeFrontmatterBlock(frontmatterText: string): FrontmatterAnalysis {
  const issues = detectFrontmatterRoundTripIssues(frontmatterText);
  const parsed = parseYamlFrontmatter(frontmatterText);
  let canRoundTrip = issues.length === 0;
  if (canRoundTrip) {
    try {
      canRoundTrip = stringifyFrontmatter(parsed) === frontmatterText;
    } catch {
      canRoundTrip = false;
    }
  }
  return { parsed, canRoundTrip, issues };
}

export function parseFrontmatterMarkdown(raw: string): MarkdownDoc {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim(), hasFrontmatter: false };
  }

  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: {}, body: normalized.trim(), hasFrontmatter: false };
  }

  const frontmatterRaw = normalized.slice(4, closing);
  const body = normalized.slice(closing + 5).trim();
  return {
    frontmatter: parseYamlFrontmatter(frontmatterRaw),
    body,
    hasFrontmatter: true,
  };
}

function assertSerializableRecord(value: Record<string, unknown>) {
  const out: Record<string, SerializableFrontmatterValue> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (entryValue === undefined) continue;
    out[key] = assertSerializableValue(entryValue);
  }
  return out;
}

function assertSerializableValue(value: unknown): SerializableFrontmatterValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Frontmatter numbers must be finite.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry !== undefined)
      .map((entry) => assertSerializableValue(entry));
  }
  if (isPlainRecord(value)) {
    return assertSerializableRecord(value);
  }
  throw new TypeError(`Unsupported frontmatter value type: ${typeof value}`);
}

function stringifyYamlRecord(record: Record<string, SerializableFrontmatterValue>, indentLevel: number): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    assertYamlKey(key);
    lines.push(...stringifyYamlProperty(key, value, indentLevel));
  }
  return lines;
}

function stringifyYamlProperty(key: string, value: SerializableFrontmatterValue, indentLevel: number): string[] {
  const indent = " ".repeat(indentLevel);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}${key}: []`];
    return [`${indent}${key}:`, ...stringifyYamlArray(value, indentLevel + 2)];
  }
  if (isSerializableRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${indent}${key}: {}`];
    return [`${indent}${key}:`, ...stringifyYamlRecord(value, indentLevel + 2)];
  }
  if (typeof value === "string" && value.includes("\n")) {
    return stringifyBlockScalarProperty(key, value, indentLevel);
  }
  return [`${indent}${key}: ${stringifyYamlScalar(value)}`];
}

function stringifyYamlArray(values: SerializableFrontmatterValue[], indentLevel: number): string[] {
  const indent = " ".repeat(indentLevel);
  const lines: string[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${indent}- []`);
      } else {
        lines.push(`${indent}-`);
        lines.push(...stringifyYamlArray(value, indentLevel + 2));
      }
      continue;
    }

    if (isSerializableRecord(value)) {
      const entries = Object.entries(value);
      if (entries.length === 0) {
        lines.push(`${indent}- {}`);
      } else {
        lines.push(`${indent}-`);
        lines.push(...stringifyYamlRecord(value, indentLevel + 2));
      }
      continue;
    }

    if (typeof value === "string" && value.includes("\n")) {
      lines.push(...stringifyBlockScalarArrayItem(value, indentLevel));
      continue;
    }

    lines.push(`${indent}- ${stringifyYamlScalar(value)}`);
  }
  return lines;
}

function stringifyBlockScalarProperty(key: string, value: string, indentLevel: number) {
  const indent = " ".repeat(indentLevel);
  return [
    `${indent}${key}: ${blockScalarIndicator(value)}`,
    ...indentBlockScalarValue(value, indentLevel + 2),
  ];
}

function stringifyBlockScalarArrayItem(value: string, indentLevel: number) {
  const indent = " ".repeat(indentLevel);
  return [
    `${indent}- ${blockScalarIndicator(value)}`,
    ...indentBlockScalarValue(value, indentLevel + 2),
  ];
}

function blockScalarIndicator(value: string) {
  if (!value.endsWith("\n")) return "|-";
  if (value.endsWith("\n\n")) return "|+";
  return "|";
}

function indentBlockScalarValue(value: string, indentLevel: number) {
  const indent = " ".repeat(indentLevel);
  return value.split("\n").map((line) => `${indent}${line}`);
}

function stringifyYamlScalar(value: Exclude<SerializableFrontmatterValue, SerializableFrontmatterValue[] | Record<string, SerializableFrontmatterValue>>) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (isPlainYamlScalar(value)) return value;
  return JSON.stringify(value);
}

function isPlainYamlScalar(value: string) {
  if (value.length === 0) return false;
  if (value.trim() !== value) return false;
  if (value === "null" || value === "~" || value === "true" || value === "false") return false;
  if (value === "[]" || value === "{}") return false;
  if (/^-?\d+(\.\d+)?$/u.test(value)) return false;
  if (/["'[\]{}#,>&*!|@`]/u.test(value)) return false;
  if (value.includes(":")) return false;
  return true;
}

function assertYamlKey(key: string) {
  if (!SUPPORTED_FRONTMATTER_KEY_RE.test(key) || key.includes(":")) {
    throw new TypeError(`Unsupported frontmatter key: ${key}`);
  }
}

function isSerializableRecord(value: SerializableFrontmatterValue): value is Record<string, SerializableFrontmatterValue> {
  return isPlainRecord(value);
}

function findRoundTripPattern(line: string, pattern: RegExp) {
  const match = pattern.exec(line);
  if (!match) return -1;
  return match.index + (match[1]?.length ?? 0);
}

function parseYamlFrontmatter(raw: string): Record<string, unknown> {
  const prepared = prepareYamlLines(raw);
  const firstContentIndex = prepared.findIndex((line) => !line.isBlank && !line.isComment);
  if (firstContentIndex < 0) return {};
  const parsed = parseYamlBlock(prepared, firstContentIndex, prepared[firstContentIndex]!.indent);
  return isPlainRecord(parsed.value) ? parsed.value : {};
}

function prepareYamlLines(raw: string) {
  return raw
    .split("\n")
    .map((line) => ({
      indent: line.match(/^ */)?.[0].length ?? 0,
      raw: line,
      content: line.trim(),
      isBlank: line.trim().length === 0,
      isComment: line.trim().startsWith("#"),
    }));
}

function parseYamlBlock(
  lines: Array<{ indent: number; raw: string; content: string; isBlank: boolean; isComment: boolean }>,
  startIndex: number,
  indentLevel: number,
): { value: unknown; nextIndex: number } {
  let index = startIndex;
  while (index < lines.length && (lines[index]!.isBlank || lines[index]!.isComment)) {
    index += 1;
  }
  if (index >= lines.length || lines[index]!.indent < indentLevel) {
    return { value: {}, nextIndex: index };
  }

  const isArray = lines[index]!.indent === indentLevel && lines[index]!.content.startsWith("-");
  if (isArray) {
    const values: unknown[] = [];
    while (index < lines.length) {
      const line = lines[index]!;
      if (line.isBlank || line.isComment) {
        index += 1;
        continue;
      }
      if (line.indent < indentLevel) break;
      if (line.indent !== indentLevel || !line.content.startsWith("-")) break;

      const remainder = line.content.slice(1).trim();
      index += 1;
      if (!remainder) {
        const nested = parseYamlBlock(lines, index, indentLevel + 2);
        values.push(nested.value);
        index = nested.nextIndex;
        continue;
      }

      if (isYamlBlockScalarIndicator(remainder)) {
        const block = parseYamlBlockScalar(lines, index, indentLevel, remainder);
        values.push(block.value);
        index = block.nextIndex;
        continue;
      }

      const inlineObjectSeparator = remainder.indexOf(":");
      if (
        inlineObjectSeparator > 0
        && !remainder.startsWith("\"")
        && !remainder.startsWith("{")
        && !remainder.startsWith("[")
      ) {
        const key = remainder.slice(0, inlineObjectSeparator).trim();
        const rawValue = remainder.slice(inlineObjectSeparator + 1).trim();
        const nextObject: Record<string, unknown> = {
          [key]: parseYamlScalar(rawValue),
        };
        if (index < lines.length && lines[index]!.indent > indentLevel) {
          const nested = parseYamlBlock(lines, index, indentLevel + 2);
          if (isPlainRecord(nested.value)) {
            Object.assign(nextObject, nested.value);
          }
          index = nested.nextIndex;
        }
        values.push(nextObject);
        continue;
      }

      values.push(parseYamlScalar(remainder));
    }
    return { value: values, nextIndex: index };
  }

  const record: Record<string, unknown> = {};
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.isBlank || line.isComment) {
      index += 1;
      continue;
    }
    if (line.indent < indentLevel) break;
    if (line.indent !== indentLevel) {
      index += 1;
      continue;
    }

    const separatorIndex = line.content.indexOf(":");
    if (separatorIndex <= 0) {
      index += 1;
      continue;
    }

    const key = line.content.slice(0, separatorIndex).trim();
    const remainder = line.content.slice(separatorIndex + 1).trim();
    index += 1;
    if (!remainder) {
      const nested = parseYamlBlock(lines, index, indentLevel + 2);
      record[key] = nested.value;
      index = nested.nextIndex;
      continue;
    }
    if (isYamlBlockScalarIndicator(remainder)) {
      const block = parseYamlBlockScalar(lines, index, indentLevel, remainder);
      record[key] = block.value;
      index = block.nextIndex;
      continue;
    }
    record[key] = parseYamlScalar(remainder);
  }

  return { value: record, nextIndex: index };
}

function isYamlBlockScalarIndicator(rawValue: string) {
  return /^[>|][+-]?$/.test(rawValue.trim());
}

function parseYamlBlockScalar(
  lines: Array<{ indent: number; raw: string; content: string; isBlank: boolean; isComment: boolean }>,
  startIndex: number,
  parentIndent: number,
  indicator: string,
): { value: string; nextIndex: number } {
  const trimmedIndicator = indicator.trim();
  const style = trimmedIndicator[0];
  const chomp = trimmedIndicator.endsWith("+")
    ? "+"
    : trimmedIndicator.endsWith("-")
      ? "-"
      : "";
  let index = startIndex;
  const collected: Array<{ indent: number; raw: string; isBlank: boolean }> = [];
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.isBlank && line.indent <= parentIndent) break;
    collected.push({ indent: line.indent, raw: line.raw, isBlank: line.isBlank });
    index += 1;
  }

  const contentLines = collected.filter((line) => !line.isBlank);
  if (contentLines.length === 0) return { value: "", nextIndex: index };

  const blockIndent = Math.min(...contentLines.map((line) => line.indent));
  const normalizedLines = collected.map((line) => (
    line.isBlank ? "" : line.raw.slice(Math.min(blockIndent, line.raw.length))
  ));

  const baseValue = style === "|"
    ? normalizedLines.join("\n")
    : foldYamlBlockScalarLines(normalizedLines);

  return {
    value: applyYamlBlockChomp(baseValue, chomp),
    nextIndex: index,
  };
}

function foldYamlBlockScalarLines(lines: string[]) {
  let value = "";
  let pendingBlankLines = 0;
  for (const line of lines) {
    if (line === "") {
      pendingBlankLines += 1;
      continue;
    }
    if (value.length === 0) {
      value = `${"\n".repeat(pendingBlankLines)}${line}`;
    } else if (pendingBlankLines > 0) {
      value += `${"\n".repeat(pendingBlankLines + 1)}${line}`;
    } else {
      value += ` ${line}`;
    }
    pendingBlankLines = 0;
  }

  if (pendingBlankLines > 0 && value.length > 0) {
    value += "\n".repeat(pendingBlankLines);
  }
  return value;
}

function applyYamlBlockChomp(value: string, chomp: "" | "+" | "-") {
  if (chomp === "+") return value;
  if (chomp === "-") return value.replace(/\n+$/u, "");
  if (value.length === 0) return value;
  return value.replace(/\n+$/u, "") + "\n";
}

function parseYamlScalar(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (trimmed === "") return "";
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    trimmed.startsWith("\"") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("{")
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}
