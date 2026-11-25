import { GoogleToolError } from "../errors.js";

export const MAX_QUERY_LENGTH = 4000;
const MAX_DEPTH = 32;

type Token =
  | { kind: "string"; value: string }
  | { kind: "word"; value: string }
  | { kind: "op"; value: string }
  | { kind: "paren"; value: "(" | ")" };

type Value = { kind: "string"; value: string } | { kind: "boolean"; value: boolean };

export type QueryNode =
  | { kind: "and" | "or"; left: QueryNode; right: QueryNode }
  | { kind: "not"; operand: QueryNode }
  | { kind: "compare"; term: string; op: string; value: Value }
  | { kind: "in"; term: string; value: string };

function invalid(detail: string): GoogleToolError {
  return new GoogleToolError("invalid_argument", `Invalid search query: ${detail}`);
}

export function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < query.length) {
    const char = query[index]!;
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === "(" || char === ")") {
      tokens.push({ kind: "paren", value: char });
      index += 1;
    } else if (char === "'" || char === "\"") {
      let value = "";
      index += 1;
      for (;;) {
        if (index >= query.length) throw invalid("a quoted value is not closed.");
        const next = query[index]!;
        if (next === "\\") {
          if (index + 1 >= query.length) throw invalid("a quoted value ends with a backslash.");
          value += query[index + 1];
          index += 2;
        } else if (next === char) {
          index += 1;
          break;
        } else {
          value += next;
          index += 1;
        }
      }
      tokens.push({ kind: "string", value });
    } else {
      const op = /^(!=|<=|>=|=|<|>)/.exec(query.slice(index));
      if (op) {
        tokens.push({ kind: "op", value: op[1]! });
        index += op[1]!.length;
        continue;
      }
      const word = /^[A-Za-z][A-Za-z0-9_]*/.exec(query.slice(index));
      if (!word) throw invalid(`unexpected character ${JSON.stringify(char)}.`);
      tokens.push({ kind: "word", value: word[0] });
      index += word[0].length;
    }
  }
  return tokens;
}

const KEYWORDS = new Set(["and", "or", "not", "in", "contains", "true", "false"]);

class Parser {
  private position = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): QueryNode {
    const node = this.or(0);
    if (this.position < this.tokens.length) throw invalid(`unexpected ${this.describe(this.tokens[this.position])}.`);
    return node;
  }

  private peekKeyword(word: string): boolean {
    const token = this.tokens[this.position];
    return token?.kind === "word" && token.value.toLowerCase() === word;
  }

  private describe(token: Token | undefined): string {
    return token ? JSON.stringify(token.value) : "end of query";
  }

  private or(depth: number): QueryNode {
    let left = this.and(depth);
    while (this.peekKeyword("or")) {
      this.position += 1;
      left = { kind: "or", left, right: this.and(depth) };
    }
    return left;
  }

  private and(depth: number): QueryNode {
    let left = this.not(depth);
    while (this.peekKeyword("and")) {
      this.position += 1;
      left = { kind: "and", left, right: this.not(depth) };
    }
    return left;
  }

  private not(depth: number): QueryNode {
    if (depth > MAX_DEPTH) throw invalid("too deeply nested.");
    if (this.peekKeyword("not")) {
      this.position += 1;
      return { kind: "not", operand: this.not(depth + 1) };
    }
    return this.primary(depth);
  }

  private primary(depth: number): QueryNode {
    const token = this.tokens[this.position];
    if (token?.kind === "paren" && token.value === "(") {
      this.position += 1;
      const node = this.or(depth + 1);
      const close = this.tokens[this.position];
      if (close?.kind !== "paren" || close.value !== ")") throw invalid(`expected ")" but found ${this.describe(close)}.`);
      this.position += 1;
      return node;
    }
    if (token?.kind === "string") {
      this.position += 1;
      if (!this.peekKeyword("in")) throw invalid(`expected "in" after ${this.describe(token)}.`);
      this.position += 1;
      const term = this.tokens[this.position];
      if (term?.kind !== "word" || KEYWORDS.has(term.value.toLowerCase())) throw invalid(`expected a term after "in" but found ${this.describe(term)}.`);
      this.position += 1;
      return { kind: "in", term: term.value, value: token.value };
    }
    if (token?.kind === "word" && !KEYWORDS.has(token.value.toLowerCase())) {
      this.position += 1;
      const op = this.tokens[this.position];
      let operator: string;
      if (op?.kind === "op") operator = op.value;
      else if (op?.kind === "word" && op.value.toLowerCase() === "contains") operator = "contains";
      else throw invalid(`expected an operator after ${this.describe(token)} but found ${this.describe(op)}.`);
      this.position += 1;
      const value = this.tokens[this.position];
      this.position += 1;
      if (value?.kind === "string") return { kind: "compare", term: token.value, op: operator, value: { kind: "string", value: value.value } };
      if (value?.kind === "word" && /^(true|false)$/i.test(value.value)) {
        return { kind: "compare", term: token.value, op: operator, value: { kind: "boolean", value: value.value.toLowerCase() === "true" } };
      }
      throw invalid(`expected a quoted value or true/false after ${JSON.stringify(`${token.value} ${operator}`)} but found ${this.describe(value)}.`);
    }
    throw invalid(`expected a search term but found ${this.describe(token)}.`);
  }
}

export function parseQuery(query: string): QueryNode | null {
  if (query.length > MAX_QUERY_LENGTH) throw invalid(`longer than ${MAX_QUERY_LENGTH} characters.`);
  const tokens = tokenize(query);
  return tokens.length ? new Parser(tokens).parse() : null;
}

export function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const TEXT_OPS = ["contains", "=", "!="];
const TIME_OPS = ["<=", "<", "=", "!=", ">", ">="];
const EQUALITY = ["=", "!="];
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const NATIVE_VISIBILITY = new Set(["anyoneCanFind", "anyoneWithLink", "domainCanFind", "domainWithLink", "limited"]);
const UNSUPPORTED: Readonly<Record<string, string>> = {
  creator: "creator",
  sharedFrom: "sharedFrom",
  sharedTo: "sharedTo",
  followUp: "followUp",
  folderProperties: "folderProperties",
};

function requireOp(term: string, op: string, allowed: readonly string[]): void {
  if (!allowed.includes(op)) throw invalid(`${term} does not support the ${op} operator (use ${allowed.join(", ")}).`);
}

function stringValue(term: string, value: Value): string {
  if (value.kind !== "string") throw invalid(`${term} takes a quoted value.`);
  return value.value;
}

function booleanValue(term: string, value: Value): boolean {
  if (value.kind !== "boolean") throw invalid(`${term} takes true or false.`);
  return value.value;
}

function negate(op: string, clause: string): string {
  return op === "!=" ? `not ${clause}` : clause;
}

function compareToDrive(node: Extract<QueryNode, { kind: "compare" }>): string {
  const { term, op, value } = node;
  if (Object.hasOwn(UNSUPPORTED, term)) throw invalid(`the ${UNSUPPORTED[term]} term is not supported by this implementation.`);
  switch (term) {
    case "title":
      requireOp(term, op, TEXT_OPS);
      return `name ${op} ${quote(stringValue(term, value))}`;
    case "fullText":
      requireOp(term, op, ["contains"]);
      return `fullText contains ${quote(stringValue(term, value))}`;
    case "mimeType":
      requireOp(term, op, TEXT_OPS);
      return `mimeType ${op} ${quote(stringValue(term, value))}`;
    case "modifiedTime":
    case "viewedByMeTime":
    case "createdTime": {
      requireOp(term, op, TIME_OPS);
      const time = stringValue(term, value);
      if (!RFC3339.test(time)) throw invalid(`${term} takes an RFC 3339 time such as '2026-01-01T00:00:00Z'.`);
      return `${term} ${op} ${quote(time)}`;
    }
    case "parentId":
      requireOp(term, op, EQUALITY);
      return negate(op, `${quote(stringValue(term, value))} in parents`);
    case "owner":
      requireOp(term, op, EQUALITY);
      return negate(op, `${quote(stringValue(term, value))} in owners`);
    case "visibility": {
      requireOp(term, op, EQUALITY);
      const level = stringValue(term, value);
      if (NATIVE_VISIBILITY.has(level)) return `visibility ${op} ${quote(level)}`;
      if (level === "anyone" || level === "domain") {
        return negate(op, `(visibility = ${quote(`${level}CanFind`)} or visibility = ${quote(`${level}WithLink`)})`);
      }
      throw invalid(`visibility ${quote(level)} is not supported by this implementation.`);
    }
    case "sharedWithMe":
    case "starred":
    case "trashed":
      requireOp(term, op, EQUALITY);
      return `${term} ${op} ${booleanValue(term, value)}`;
    default:
      throw invalid(`unknown term ${JSON.stringify(term)}.`);
  }
}

export function toDriveQuery(node: QueryNode): string {
  switch (node.kind) {
    case "and":
    case "or":
      return `(${toDriveQuery(node.left)} ${node.kind} ${toDriveQuery(node.right)})`;
    case "not":
      return `not ${toDriveQuery(node.operand)}`;
    case "in":
      if (node.term !== "readers" && node.term !== "writers") {
        if (node.term === "folderProperties") throw invalid("the folderProperties term is not supported by this implementation.");
        throw invalid(`"in" works only with readers and writers, not ${JSON.stringify(node.term)}.`);
      }
      return `${quote(node.value)} in ${node.term}`;
    case "compare":
      return compareToDrive(node);
  }
}

function mentionsTrashed(node: QueryNode): boolean {
  switch (node.kind) {
    case "and":
    case "or":
      return mentionsTrashed(node.left) || mentionsTrashed(node.right);
    case "not":
      return mentionsTrashed(node.operand);
    case "in":
      return false;
    case "compare":
      return node.term === "trashed";
  }
}

export function driveSearchQuery(query: string | undefined): string {
  const node = parseQuery(query ?? "");
  if (!node) return "trashed = false";
  const translated = toDriveQuery(node);
  return mentionsTrashed(node) ? translated : `(${translated}) and trashed = false`;
}
