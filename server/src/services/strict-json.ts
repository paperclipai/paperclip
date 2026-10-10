/**
 * Length is bounded by the caller. This parser exists because JSON.parse keeps
 * only the final duplicate object key, which is unsafe for signed protocol
 * messages. It also avoids prototype assignment for the `__proto__` key.
 */
export function parseJsonNoDuplicateKeys(text: string): unknown {
  const parser = new StrictJsonParser(text);
  const value = parser.value();
  parser.whitespace();
  if (!parser.done()) throw new SyntaxError("Unexpected trailing JSON content");
  return value;
}

class StrictJsonParser {
  private position = 0;

  constructor(private readonly source: string) {}

  done() { return this.position >= this.source.length; }

  whitespace() {
    while (/^[\u0009\u000a\u000d\u0020]$/.test(this.source[this.position] ?? "")) this.position += 1;
  }

  value(): unknown {
    this.whitespace();
    const character = this.source[this.position];
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === '"') return this.string();
    if (this.source.startsWith("true", this.position)) { this.position += 4; return true; }
    if (this.source.startsWith("false", this.position)) { this.position += 5; return false; }
    if (this.source.startsWith("null", this.position)) { this.position += 4; return null; }
    return this.number();
  }

  private object(): Record<string, unknown> {
    this.expect("{");
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.whitespace();
    if (this.peek() === "}") { this.position += 1; return result; }
    for (;;) {
      this.whitespace();
      if (this.peek() !== '"') throw new SyntaxError("Expected JSON object key");
      const key = this.string();
      if (keys.has(key)) throw new SyntaxError("Duplicate JSON object key");
      keys.add(key);
      this.whitespace();
      this.expect(":");
      Object.defineProperty(result, key, {
        value: this.value(),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.whitespace();
      const next = this.next();
      if (next === "}") return result;
      if (next !== ",") throw new SyntaxError("Expected comma or object end");
    }
  }

  private array(): unknown[] {
    this.expect("[");
    const result: unknown[] = [];
    this.whitespace();
    if (this.peek() === "]") { this.position += 1; return result; }
    for (;;) {
      result.push(this.value());
      this.whitespace();
      const next = this.next();
      if (next === "]") return result;
      if (next !== ",") throw new SyntaxError("Expected comma or array end");
    }
  }

  private string(): string {
    this.expect('"');
    let result = "";
    for (;;) {
      if (this.done()) throw new SyntaxError("Unterminated JSON string");
      const character = this.next();
      if (character === '"') return result;
      if (character === "\\") {
        const escape = this.next();
        const simple: Record<string, string> = {
          '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
        };
        if (escape in simple) { result += simple[escape]!; continue; }
        if (escape !== "u") throw new SyntaxError("Invalid JSON string escape");
        const hex = this.source.slice(this.position, this.position + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError("Invalid JSON Unicode escape");
        result += String.fromCharCode(Number.parseInt(hex, 16));
        this.position += 4;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) throw new SyntaxError("Unescaped JSON control character");
      result += character;
    }
  }

  private number(): number {
    const expression = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    expression.lastIndex = this.position;
    const match = expression.exec(this.source);
    if (!match || match.index !== this.position) throw new SyntaxError("Invalid JSON number");
    this.position += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new SyntaxError("Non-finite JSON number");
    return value;
  }

  private peek() { return this.source[this.position]; }
  private next() {
    if (this.done()) throw new SyntaxError("Unexpected end of JSON");
    return this.source[this.position++]!;
  }
  private expect(character: string) {
    if (this.next() !== character) throw new SyntaxError(`Expected ${character}`);
  }
}
