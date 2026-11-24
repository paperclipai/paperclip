/**
 * Tool input schemas use ECMAScript regular expressions. A client that checks
 * schemas with RE2 (the Antigravity CLI, a Go program) refuses `\uXXXX`
 * escapes and with them its whole toolbox. This rewrites those escapes to the
 * equivalent RE2 form `\x{...}` in a copy of the schema served to such a
 * client. Calls are still validated by the Runner against the original schema.
 */

type Json = unknown;

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * The first construct in `pattern` that RE2 refuses (lookaround, backreference,
 * a \u or \c escape), or null. Conservative: it does not prove a pattern valid.
 */
export function re2Incompatibility(pattern: string): string | null {
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] !== "\\") continue;
    const next = pattern[index + 1] ?? "";
    if (next === "u") return "\\u escape";
    if (/[1-9]/.test(next)) return "backreference";
    if (next === "k") return "named backreference";
    if (next === "c") return "control escape";
    index++;
  }
  if (/\(\?<?[=!]/.test(pattern)) return "lookaround";
  return null;
}

/**
 * The RE2 form of an ECMAScript pattern, or null when it has none (a lone
 * surrogate, lookaround, a backreference). A schema served without such a
 * pattern is looser for the client only; the Runner validates the original.
 */
export function re2PortablePattern(pattern: string): string | null {
  const portable = escapesToRe2(pattern);
  return portable !== null && re2Incompatibility(portable) === null ? portable : null;
}

function escapesToRe2(pattern: string): string | null {
  let output = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character !== "\\") { output += character; continue; }
    const next = pattern[index + 1];
    if (next !== "u") {
      // Copy any other escape whole, so an escaped backslash never starts a new one.
      output += character + (next ?? "");
      index++;
      continue;
    }
    let codePoint: number;
    let consumed: number;
    const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(pattern.slice(index + 2));
    if (braced) {
      codePoint = Number.parseInt(braced[1]!, 16);
      consumed = 2 + braced[0].length;
    } else if (HEX4.test(pattern.slice(index + 2, index + 6))) {
      codePoint = Number.parseInt(pattern.slice(index + 2, index + 6), 16);
      consumed = 6;
      if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
        const low = pattern.slice(index + 6, index + 12);
        const lowCode = /^\\u[0-9a-fA-F]{4}$/.test(low) ? Number.parseInt(low.slice(2), 16) : NaN;
        if (!(lowCode >= 0xdc00 && lowCode <= 0xdfff)) return null;
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (lowCode - 0xdc00);
        consumed = 12;
      } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
        return null;
      }
    } else {
      return null;
    }
    output += `\\x{${codePoint.toString(16).padStart(4, "0")}}`;
    index += consumed - 1;
  }
  return output;
}

/** A copy of `schema` whose `pattern` values and `patternProperties` keys are RE2-portable. */
export function re2PortableSchema(schema: Json): Json {
  if (Array.isArray(schema)) return schema.map(re2PortableSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const result: Record<string, Json> = {};
  for (const [key, value] of Object.entries(schema as Record<string, Json>)) {
    if (key === "pattern" && typeof value === "string") {
      const portable = re2PortablePattern(value);
      if (portable !== null) result[key] = portable;
    } else if (key === "patternProperties" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const properties: Record<string, Json> = {};
      for (const [pattern, subschema] of Object.entries(value as Record<string, Json>)) {
        const portable = re2PortablePattern(pattern);
        if (portable !== null) properties[portable] = re2PortableSchema(subschema);
      }
      result[key] = properties;
    } else {
      result[key] = re2PortableSchema(value);
    }
  }
  return result;
}
