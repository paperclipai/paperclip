import { normalizePath, parseAst, type Plugin } from "vite";

interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

export interface DisplayCopyResult {
  code: string;
  strings: string[];
}

export const DISPLAY_TEXT_MODULE = "@/i18n/display-text";
export const DISPLAY_TEXT_BINDING = "__paperclipDisplayText";

const DISPLAY_ATTRIBUTES = new Set([
  "aria-label",
  "title",
  "placeholder",
  "alt",
  "label",
  "description",
  "helperText",
  "emptyMessage",
  "confirmLabel",
  "cancelLabel",
  "tooltip",
  "emptyText",
  "submitLabel",
  "heading",
  "subtitle",
  "footnote",
]);

const OPAQUE_ELEMENTS = new Set(["code", "pre", "script", "style", "textarea", "kbd", "samp"]);
const OPT_OUT_ATTRIBUTES = new Set(["contentEditable", "data-no-translate", "dangerouslySetInnerHTML"]);
const SKIPPED_KEYS = new Set(["type", "start", "end", "range", "loc"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: "\u00a0",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  laquo: "\u00ab",
  raquo: "\u00bb",
  middot: "\u00b7",
  bull: "\u2022",
  times: "\u00d7",
  larr: "\u2190",
  rarr: "\u2192",
  uarr: "\u2191",
  darr: "\u2193",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  deg: "\u00b0",
};

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function childNode(node: AstNode, key: string): AstNode | null {
  const value = node[key];
  return isNode(value) ? value : null;
}

function childNodes(node: AstNode, key: string): AstNode[] {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
}

function hasLetters(text: string): boolean {
  return /[A-Za-z]{2}/.test(text);
}

function attributeName(attribute: AstNode): string | null {
  const name = childNode(attribute, "name");
  return name?.type === "JSXIdentifier" && typeof name.name === "string" ? name.name : null;
}

export function decodeJsxEntities(raw: string): string | null {
  let unsupported = false;
  const decoded = raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    const value = NAMED_ENTITIES[entity];
    if (value === undefined) unsupported = true;
    return value ?? match;
  });
  return unsupported ? null : decoded;
}

export function cleanJsxText(value: string): string {
  const lines = value.split(/\r\n|\n|\r/);
  let lastNonEmptyLine = 0;
  for (let index = 0; index < lines.length; index++) {
    if (/[^ \t]/.test(lines[index])) lastNonEmptyLine = index;
  }
  let text = "";
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index].replace(/\t/g, " ");
    if (index !== 0) line = line.replace(/^[ ]+/, "");
    if (index !== lines.length - 1) line = line.replace(/[ ]+$/, "");
    if (!line) continue;
    if (index !== lastNonEmptyLine) line += " ";
    text += line;
  }
  return text;
}

function countLineBreaks(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

export function isDisplayCopyModule(id: string): boolean {
  const file = id.split("?")[0];
  return /\.[jt]sx$/.test(file) && !/\.(test|spec|stories)\.[jt]sx$/.test(file) && !file.includes("/node_modules/");
}

export function transformDisplayCopy(code: string, id: string): DisplayCopyResult | null {
  if (!isDisplayCopyModule(id)) return null;
  const file = id.split("?")[0];
  const program = parseAst(code, { lang: file.endsWith(".jsx") ? "jsx" : "tsx" }) as unknown as AstNode;
  const edits: Edit[] = [];
  const strings = new Set<string>();

  const call = (text: string, values?: string) => {
    strings.add(text);
    return `${DISPLAY_TEXT_BINDING}(${JSON.stringify(text)}${values ? `, ${values}` : ""})`;
  };

  const replace = (node: AstNode, text: string) => {
    const missing = countLineBreaks(code.slice(node.start, node.end)) - countLineBreaks(text);
    edits.push({ start: node.start, end: node.end, text: text + "\n".repeat(Math.max(0, missing)) });
  };

  const wrapExpression = (expression: AstNode | null) => {
    if (!expression) return;
    if (expression.type === "Literal" && typeof expression.value === "string") {
      if (hasLetters(expression.value)) replace(expression, call(expression.value));
      return;
    }
    if (expression.type === "TemplateLiteral") {
      const quasis = childNodes(expression, "quasis");
      const expressions = childNodes(expression, "expressions");
      const cooked = quasis.map((quasi) => (quasi.value as { cooked?: string | null } | undefined)?.cooked);
      if (cooked.every((part): part is string => typeof part === "string") && hasLetters(cooked.join(""))) {
        const template = cooked.map((part, index) => part + (index < expressions.length ? `{{v${index}}}` : "")).join("");
        const values = expressions.length
          ? `{ ${expressions.map((value, index) => `v${index}: (${code.slice(value.start, value.end)})`).join(", ")} }`
          : undefined;
        replace(expression, call(template, values));
        return;
      }
    }
    if (expression.type === "ConditionalExpression") {
      visit(childNode(expression, "test"));
      wrapExpression(childNode(expression, "consequent"));
      wrapExpression(childNode(expression, "alternate"));
      return;
    }
    if (expression.type === "LogicalExpression") {
      visit(childNode(expression, "left"));
      wrapExpression(childNode(expression, "right"));
      return;
    }
    if (expression.type === "ParenthesizedExpression") {
      wrapExpression(childNode(expression, "expression"));
      return;
    }
    visit(expression);
  };

  const visitChildren = (nodes: AstNode[]) => {
    for (const node of nodes) {
      if (node.type === "JSXText" && typeof node.value === "string") {
        const decoded = decodeJsxEntities(node.value);
        if (decoded === null) continue;
        const text = cleanJsxText(decoded);
        if (hasLetters(text)) replace(node, `{${call(text)}}`);
        continue;
      }
      if (node.type === "JSXExpressionContainer") {
        wrapExpression(childNode(node, "expression"));
        continue;
      }
      visit(node);
    }
  };

  const visitAttribute = (attribute: AstNode) => {
    const name = attributeName(attribute);
    const value = childNode(attribute, "value");
    if (!name || !value || !DISPLAY_ATTRIBUTES.has(name)) {
      visit(value);
      return;
    }
    if (value.type === "Literal" && typeof value.value === "string") {
      const decoded = decodeJsxEntities(value.value);
      if (decoded !== null && hasLetters(decoded)) replace(value, `{${call(decoded)}}`);
      return;
    }
    if (value.type === "JSXExpressionContainer") {
      wrapExpression(childNode(value, "expression"));
      return;
    }
    visit(value);
  };

  function visit(node: AstNode | null) {
    if (!node) return;
    if (node.type === "JSXElement") {
      const opening = childNode(node, "openingElement");
      const name = opening ? childNode(opening, "name") : null;
      const attributes = opening ? childNodes(opening, "attributes") : [];
      const elementName = name?.type === "JSXIdentifier" && typeof name.name === "string" ? name.name : null;
      if (elementName && OPAQUE_ELEMENTS.has(elementName)) return;
      if (attributes.some((attribute) => OPT_OUT_ATTRIBUTES.has(attributeName(attribute) ?? ""))) return;
      if (elementName === "option" && !attributes.some((attribute) => attributeName(attribute) === "value")) return;
      for (const attribute of attributes) {
        if (attribute.type === "JSXAttribute") visitAttribute(attribute);
        else visit(attribute);
      }
      visitChildren(childNodes(node, "children"));
      return;
    }
    if (node.type === "JSXFragment") {
      visitChildren(childNodes(node, "children"));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (SKIPPED_KEYS.has(key)) continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visit(item);
      } else if (isNode(value)) {
        visit(value);
      }
    }
  }

  visit(program);
  if (edits.length === 0) return null;
  edits.sort((left, right) => right.start - left.start);
  let output = code;
  for (const edit of edits) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  output += `\nimport { displayText as ${DISPLAY_TEXT_BINDING} } from ${JSON.stringify(DISPLAY_TEXT_MODULE)};\n`;
  return { code: output, strings: [...strings].sort() };
}

export function displayCopyPlugin(): Plugin {
  let sourceRoot = "";
  return {
    name: "paperclip-display-copy",
    enforce: "pre",
    configResolved(config) {
      sourceRoot = `${normalizePath(config.root)}/src/`;
    },
    transform(code, id) {
      if (!normalizePath(id).startsWith(sourceRoot)) return null;
      let result: DisplayCopyResult | null;
      try {
        result = transformDisplayCopy(code, id);
      } catch {
        return null;
      }
      return result ? { code: result.code, map: null } : null;
    },
  };
}
