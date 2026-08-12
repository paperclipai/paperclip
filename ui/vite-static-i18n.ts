import path from "node:path";
import ts from "typescript";
import type { Plugin } from "vite";

const helper = "__paperclipTranslateUiLiteral";
const localeHook = "__paperclipUseUiLiteralLocale";
const translatableAttributes = /^(?:alt|aria-description|aria-label|buttonLabel|cancelLabel|confirmLabel|description|empty(?:Message|Text)|error(?:Message|Text)?|help(?:Text)?|hint|label|message|placeholder|subtitle|title|tooltip)$/i;
const userFeedbackCalls = /(?:^|\.)(?:addToast|alert|confirm|prompt|showToast|toast)$|(?:^|\.)(?:toast|toasts)\.(?:error|info|success|warn|warning)$/;
const skippedElements = new Set(["code", "kbd", "noscript", "pre", "script", "style", "textarea"]);

function callName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return `${callName(expression.expression)}.${expression.name.text}`;
  return "";
}

function expressionText(node: ts.Expression) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    node.templateSpans.forEach((span, index) => {
      value += `{{value${index + 1}}}${span.literal.text}`;
    });
    return value;
  }
  return null;
}

function containsEnglish(value: string) {
  return /[A-Za-z]{2,}/.test(value.replace(/{{value\d+}}/g, ""));
}

// Matches the whitespace folding performed for JSX text by React's compiler.
function cleanJsxText(value: string) {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  let result = "";
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].replace(/\t/g, " ");
    if (index !== 0) line = line.replace(/^ +/, "");
    if (index !== lines.length - 1) line = line.replace(/ +$/, "");
    if (!line) continue;
    result += line;
    if (index !== lines.length - 1) result += " ";
  }
  return result;
}

function isInsideSkippedElement(node: ts.Node) {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isJsxElement(current)) continue;
    const tag = current.openingElement.tagName.getText().toLowerCase();
    if (skippedElements.has(tag)) return true;
  }
  return false;
}

export function staticUiLocalization(): Plugin {
  return {
    name: "paperclip-static-ui-localization",
    enforce: "pre",
    transform(source, rawId) {
      const id = rawId.split("?", 1)[0];
      const normalizedId = id.split(path.sep).join("/");
      if (
        !/\.tsx?$/.test(id) ||
        !normalizedId.includes("/src/") ||
        normalizedId.includes("/src/i18n/") ||
        /(?:\.test|\.stories)\.tsx?$/.test(id)
      ) return null;

      const sourceFile = ts.createSourceFile(
        id,
        source,
        ts.ScriptTarget.Latest,
        true,
        id.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const replacements = new Map<number, { end: number; value: string }>();
      const componentBodies = new Set<number>();

      function markComponentOwner(node: ts.Node) {
        for (let current = node.parent; current; current = current.parent) {
          if (ts.isFunctionDeclaration(current) && current.name && /^[A-Z]/.test(current.name.text)) {
            componentBodies.add(current.body.getStart(sourceFile) + 1);
            return;
          }
          if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) continue;
          if (!ts.isBlock(current.body)) continue;
          let parent: ts.Node = current.parent;
          if (ts.isCallExpression(parent)) parent = parent.parent;
          if (
            ts.isVariableDeclaration(parent) &&
            ts.isIdentifier(parent.name) &&
            /^[A-Z]/.test(parent.name.text)
          ) {
            componentBodies.add(current.body.getStart(sourceFile) + 1);
            return;
          }
        }
      }

      function addExpression(node: ts.Expression) {
        const text = expressionText(node);
        if (text === null || !containsEnglish(text)) return;
        replacements.set(node.getStart(sourceFile), {
          end: node.end,
          value: `${helper}(${node.getText(sourceFile)})`,
        });
        markComponentOwner(node);
      }

      function collectExpression(node: ts.Expression) {
        if (ts.isCallExpression(node)) {
          const name = callName(node.expression);
          if (name === "t" || name.endsWith(".t") || name === helper) return;
        }
        if (expressionText(node) !== null) {
          addExpression(node);
          return;
        }
        if (ts.isJsxElement(node) || ts.isJsxFragment(node) || ts.isJsxSelfClosingElement(node)) return;
        ts.forEachChild(node, (child) => {
          if (ts.isExpression(child)) collectExpression(child);
        });
      }

      function visit(node: ts.Node) {
        if (ts.isCallExpression(node)) {
          const name = callName(node.expression);
          if (name === "t" || name.endsWith(".t") || name === helper) return;
          if (userFeedbackCalls.test(name)) node.arguments.forEach(addExpression);
        }

        if (ts.isJsxText(node) && !isInsideSkippedElement(node)) {
          const text = cleanJsxText(node.getText(sourceFile));
          if (containsEnglish(text)) {
            replacements.set(node.getStart(sourceFile), {
              end: node.end,
              value: `{${helper}(${JSON.stringify(text)})}`,
            });
            markComponentOwner(node);
          }
        }

        if (ts.isJsxAttribute(node)) {
          const name = node.name.getText(sourceFile);
          if (translatableAttributes.test(name) && node.initializer) {
            if (ts.isStringLiteral(node.initializer) && containsEnglish(node.initializer.text)) {
              replacements.set(node.initializer.getStart(sourceFile), {
                end: node.initializer.end,
                value: `{${helper}(${JSON.stringify(node.initializer.text)})}`,
              });
              markComponentOwner(node);
            } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
              collectExpression(node.initializer.expression);
            }
          }
        } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
          collectExpression(node.expression);
        }

        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
      if (!replacements.size) return null;

      for (const position of componentBodies) {
        replacements.set(position, { end: position, value: `\n${localeHook}();` });
      }

      let code = source;
      for (const [start, replacement] of [...replacements].sort((left, right) => right[0] - left[0])) {
        code = `${code.slice(0, start)}${replacement.value}${code.slice(replacement.end)}`;
      }
      code = `import { translateUiLiteral as ${helper}, useUiLiteralLocale as ${localeHook} } from "@/i18n/LegacyLiteralLocalizer";\n${code}`;
      return { code, map: null };
    },
  };
}
