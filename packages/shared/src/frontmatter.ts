export interface MarkdownDoc {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

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
  if (/^-?\d+(\.\d)?\d*$/.test(trimmed)) return Number(trimmed);
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
