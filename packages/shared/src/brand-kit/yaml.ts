// Minimal, dependency-free block-YAML parser + canonical emitter scoped to the
// DESIGN.md brand-kit artifact (see ./schema.ts). The wider `@paperclipai/shared`
// package only ships `zod` as a runtime dependency, so we deliberately avoid
// pulling in a general YAML library: a focused parser/emitter pair guarantees a
// stable, deterministic round-trip (emit(parse(x)) is idempotent) which the
// brand-kit artifact relies on.
//
// Supported subset (block style only):
//   - mappings (`key: value` and nested `key:` + indented block)
//   - block sequences of scalars (`- value`)
//   - block sequences of mappings (`- key: value` with aligned continuation keys)
//   - scalars: double/single-quoted strings, plain strings, numbers, booleans, null
//   - inline empty collections `{}` and `[]`, and inline JSON-style arrays
//   - full-line `#` comments and blank lines (ignored)
//
// Anything outside this subset (anchors, block scalars `|`/`>`, complex keys,
// inline comments after values) is intentionally unsupported.

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

interface Line {
  indent: number;
  content: string;
}

function toLines(raw: string): Line[] {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const indent = line.match(/^ */)?.[0].length ?? 0;
      return { indent, content: line.slice(indent).replace(/\s+$/, "") };
    })
    .filter((line) => line.content.length > 0 && !line.content.startsWith("#"));
}

function isDashLine(content: string): boolean {
  return content === "-" || content.startsWith("- ");
}

function looksLikeMappingEntry(content: string): boolean {
  if (content.startsWith("\"") || content.startsWith("'")) return false;
  return /^[^:\s][^:]*:(\s|$)/.test(content);
}

export function parseYaml(raw: string): YamlValue {
  const lines = toLines(raw);
  if (lines.length === 0) return {};
  const { value } = parseNode(lines, 0, lines[0]!.indent);
  return value;
}

function parseNode(lines: Line[], index: number, indent: number): { value: YamlValue; next: number } {
  if (index >= lines.length || lines[index]!.indent < indent) {
    return { value: null, next: index };
  }
  if (lines[index]!.indent === indent && isDashLine(lines[index]!.content)) {
    return parseSequence(lines, index, indent);
  }
  return parseMapping(lines, index, indent);
}

function parseSequence(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const out: YamlValue[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent !== indent || !isDashLine(line.content)) break;

    const dashRest = line.content.slice(1);
    const lead = dashRest.length - dashRest.trimStart().length;
    const after = dashRest.trim();

    if (after === "") {
      // Nested block value on the following (more-indented) lines.
      index += 1;
      if (index < lines.length && lines[index]!.indent > indent) {
        const nested = parseNode(lines, index, lines[index]!.indent);
        out.push(nested.value);
        index = nested.next;
      } else {
        out.push(null);
      }
      continue;
    }

    if (looksLikeMappingEntry(after)) {
      // Sequence item that is a mapping whose first key is inline after the dash.
      const childIndent = indent + 1 + lead;
      // Rewrite the current line into a plain mapping entry at the child indent so
      // parseMapping consumes it together with any aligned continuation keys.
      lines[index] = { indent: childIndent, content: after };
      const nested = parseMapping(lines, index, childIndent);
      out.push(nested.value);
      index = nested.next;
      continue;
    }

    out.push(parseScalar(after));
    index += 1;
  }
  return { value: out, next: index };
}

function parseMapping(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const out: { [key: string]: YamlValue } = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      // Defensive: skip stray over-indented lines rather than throwing.
      index += 1;
      continue;
    }
    if (isDashLine(line.content)) break;

    const separator = line.content.indexOf(":");
    if (separator < 0) {
      index += 1;
      continue;
    }

    const key = line.content.slice(0, separator).trim();
    const rest = line.content.slice(separator + 1).trim();
    index += 1;

    if (rest !== "") {
      out[key] = parseScalar(rest);
      continue;
    }

    if (index < lines.length && lines[index]!.indent > indent) {
      const nested = parseNode(lines, index, lines[index]!.indent);
      out[key] = nested.value;
      index = nested.next;
    } else if (index < lines.length && lines[index]!.indent === indent && isDashLine(lines[index]!.content)) {
      // Sequence indented at the same column as its key.
      const nested = parseSequence(lines, index, indent);
      out[key] = nested.value;
      index = nested.next;
    } else {
      out[key] = null;
    }
  }
  return { value: out, next: index };
}

function parseScalar(raw: string): YamlValue {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};

  if (trimmed.startsWith("\"")) {
    try {
      return JSON.parse(trimmed) as YamlValue;
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as YamlValue;
    } catch {
      return trimmed;
    }
  }
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d*\.\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

const RESERVED_PLAIN = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

function isSafePlainScalar(value: string): boolean {
  if (value.length === 0) return false;
  if (RESERVED_PLAIN.has(value.toLowerCase())) return false;
  if (/\s$/.test(value)) return false;
  return /^[A-Za-z][A-Za-z0-9 _-]*$/.test(value);
}

function emitScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (isSafePlainScalar(value)) return value;
  return JSON.stringify(value);
}

function isPlainObject(value: YamlValue): value is { [key: string]: YamlValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitMapping(obj: { [key: string]: YamlValue }, indent: number): string[] {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) {
        lines.push(`${pad}${key}: {}`);
        continue;
      }
      lines.push(`${pad}${key}:`);
      lines.push(...emitMapping(value, indent + 2));
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}${key}: []`);
        continue;
      }
      lines.push(`${pad}${key}:`);
      lines.push(...emitSequence(value, indent + 2));
    } else {
      lines.push(`${pad}${key}: ${emitScalar(value)}`);
    }
  }
  return lines;
}

function emitSequence(arr: YamlValue[], indent: number): string[] {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const item of arr) {
    if (isPlainObject(item)) {
      const entries = Object.entries(item).filter(([, v]) => v !== undefined);
      if (entries.length === 0) {
        lines.push(`${pad}- {}`);
        continue;
      }
      const itemLines = emitMapping(Object.fromEntries(entries), indent + 2);
      // Re-attach the dash to the first emitted line.
      lines.push(pad + "- " + itemLines[0]!.slice(indent + 2));
      lines.push(...itemLines.slice(1));
    } else if (Array.isArray(item)) {
      lines.push(`${pad}-`);
      lines.push(...emitSequence(item, indent + 2));
    } else {
      lines.push(`${pad}- ${emitScalar(item)}`);
    }
  }
  return lines;
}

export function emitYaml(value: { [key: string]: YamlValue }): string {
  return emitMapping(value, 0).join("\n");
}
