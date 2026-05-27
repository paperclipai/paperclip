// AST-driven mutator for ui-anchors.ts. Finds an anchor block by `id` and
// rewrites the single string-literal argument to its `hasSelector(b, '<sel>')`
// check while preserving the rest of the file byte-for-byte.
//
// V1 scope: only anchors whose check body has the exact concise shape
//   check: async (b) => ({ ok: await hasSelector(b, '<sel>') })
// are patchable. Anchors with `hasButtonMatching`, complex `evalValue` walkers,
// or block-bodied checks (the `if (!/file=/.test(url)) return ...` guards) are
// rejected by `canPatch` — auto-heal skips them with "complex check, V1 limit".
// Extending the patcher to those shapes is V2 work; the small surface here
// keeps the failure modes shallow.

import ts from 'typescript';

export interface AnchorMatch {
  /** Byte offset of the string-literal node start (INCLUDING opening quote). */
  literalStart: number;
  /** Byte offset of the string-literal node end (EXCLUSIVE; one past closing quote). */
  literalEnd: number;
  /** The quote character used by the original literal: `'`, `"`, or `` ` ``. */
  quote: "'" | '"' | '`';
  /** Decoded (unquoted) string content. */
  currentSelector: string;
}

export function findAnchor(source: string, id: string): AnchorMatch | null {
  const sf = ts.createSourceFile('ui-anchors.ts', source, ts.ScriptTarget.Latest, true);
  let result: AnchorMatch | null = null;

  const visit = (node: ts.Node): void => {
    if (result) return;
    if (ts.isObjectLiteralExpression(node) && matchesAnchorWithId(node, id)) {
      const checkProp = findProperty(node, 'check');
      if (checkProp) {
        const sel = extractSimpleHasSelectorArg(checkProp.initializer, sf);
        if (sel) result = sel;
      }
      return; // don't recurse into the matched anchor
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return result;
}

export function canPatch(source: string, id: string): boolean {
  return findAnchor(source, id) !== null;
}

export function patchSelector(source: string, id: string, newSelector: string): string {
  const match = findAnchor(source, id);
  if (!match) {
    throw new Error(
      `anchor-patcher: id "${id}" is not patchable — either not found or its check is not the simple hasSelector(b, '...') shape`
    );
  }
  const escaped = escapeForQuote(newSelector, match.quote);
  return (
    source.slice(0, match.literalStart) +
    match.quote +
    escaped +
    match.quote +
    source.slice(match.literalEnd)
  );
}

// ---- internals ----

function matchesAnchorWithId(obj: ts.ObjectLiteralExpression, id: string): boolean {
  const idProp = findProperty(obj, 'id');
  if (!idProp) return false;
  const init = idProp.initializer;
  if (ts.isStringLiteralLike(init)) {
    return init.text === id;
  }
  return false;
}

function findProperty(
  obj: ts.ObjectLiteralExpression,
  name: string
): ts.PropertyAssignment | null {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const n = p.name;
    if (ts.isIdentifier(n) && n.text === name) return p;
    if (ts.isStringLiteral(n) && n.text === name) return p;
  }
  return null;
}

function extractSimpleHasSelectorArg(
  expr: ts.Expression,
  sf: ts.SourceFile
): AnchorMatch | null {
  // Required shape: async (b) => ({ ok: await hasSelector(b, '<sel>') })
  if (!ts.isArrowFunction(expr)) return null;

  let body: ts.Node = expr.body;
  // Concise body wrapped in parens: ({ ok: ... })
  if (ts.isParenthesizedExpression(body)) body = body.expression;
  if (!ts.isObjectLiteralExpression(body)) return null;

  // Exactly one property named `ok`.
  if (body.properties.length !== 1) return null;
  const okProp = body.properties[0];
  if (!okProp || !ts.isPropertyAssignment(okProp)) return null;
  if (!ts.isIdentifier(okProp.name) || okProp.name.text !== 'ok') return null;

  const okValue = okProp.initializer;
  if (!ts.isAwaitExpression(okValue)) return null;

  const call = okValue.expression;
  if (!ts.isCallExpression(call)) return null;
  if (!ts.isIdentifier(call.expression) || call.expression.text !== 'hasSelector') return null;

  // Args: (b, '<sel>')
  if (call.arguments.length !== 2) return null;
  const [arg0, arg1] = call.arguments;
  if (!arg0 || !arg1) return null;
  if (!ts.isIdentifier(arg0) || arg0.text !== 'b') return null;
  if (!ts.isStringLiteralLike(arg1)) return null;

  const raw = arg1.getText(sf);
  const quote = detectQuote(raw);
  if (!quote) return null;

  return {
    literalStart: arg1.getStart(sf),
    literalEnd: arg1.getEnd(),
    quote,
    currentSelector: arg1.text
  };
}

function detectQuote(literalText: string): "'" | '"' | '`' | null {
  const first = literalText[0];
  if (first === "'" || first === '"' || first === '`') return first;
  return null;
}

function escapeForQuote(s: string, quote: "'" | '"' | '`'): string {
  // Backslash always escapes; the specific quote character escapes; for
  // backticks we also escape `${` to avoid accidental template substitution.
  let out = s.replace(/\\/g, '\\\\');
  if (quote === "'") out = out.replace(/'/g, "\\'");
  else if (quote === '"') out = out.replace(/"/g, '\\"');
  else {
    out = out.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  }
  return out;
}
