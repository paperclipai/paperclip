#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dirname, "..");
const uiRoot = path.join(repoRoot, "ui", "src");
const scanRoots = [uiRoot];

const skippedFilePatterns = [/\.d\.ts$/, /\.test\.tsx?$/, /\.stories\.tsx?$/];
const translatableAttributes = /^(?:alt|aria-description|aria-label|buttonLabel|cancelLabel|confirmLabel|description|empty(?:Message|Text)|error(?:Message|Text)?|help(?:Text)?|hint|label|message|placeholder|subtitle|title|tooltip)$/i;
const uiObjectProperties = /^(?:ariaLabel|buttonLabel|cancelLabel|confirmLabel|description|empty(?:Message|Text)|error(?:Message|Text)?|help(?:Text)?|hint|label|message|placeholder|subtitle|title|tooltip)$/i;
const userFeedbackCalls = /(?:^|\.)(?:addToast|alert|confirm|prompt|showToast|toast)$|(?:^|\.)(?:toast|toasts)\.(?:error|info|success|warn|warning)$/;

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(absolutePath);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [absolutePath] : [];
  });
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function containsEnglishWords(value) {
  return /[A-Za-z]{2,}/.test(value.replace(/{{value\d+}}/g, ""));
}

function expressionText(node, sourceFile) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;
    node.templateSpans.forEach((span, index) => {
      result += `{{value${index + 1}}}` + span.literal.text;
    });
    return result;
  }
  return null;
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return `${callName(expression.expression)}.${expression.name.text}`;
  return "";
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function scanFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings = [];

  function add(kind, node, rawText) {
    const text = normalizeText(rawText);
    if (!text || !containsEnglishWords(text)) return;
    findings.push({
      file: path.relative(repoRoot, filePath),
      line: lineOf(sourceFile, node),
      kind,
      text,
    });
  }

  function collectExpression(node, kind) {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (name === "t" || name.endsWith(".t")) return;
    }
    const text = expressionText(node, sourceFile);
    if (text !== null) {
      add(kind, node, text);
      return;
    }
    if (
      ts.isJsxElement(node) ||
      ts.isJsxFragment(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxAttribute(node)
    ) return;
    ts.forEachChild(node, (child) => collectExpression(child, kind));
  }

  function visit(node) {
    if (ts.isJsxText(node)) add("jsx-text", node, node.getText(sourceFile));

    if (ts.isJsxAttribute(node)) {
      const attributeName = node.name.getText(sourceFile);
      if (translatableAttributes.test(attributeName) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) {
          add(`attribute:${attributeName}`, node.initializer, node.initializer.text);
        } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          collectExpression(node.initializer.expression, `attribute-expression:${attributeName}`);
        }
      }
    }

    if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      collectExpression(node.expression, "jsx-expression");
    }

    if (ts.isPropertyAssignment(node)) {
      const propertyName = node.name.getText(sourceFile).replace(/["']/g, "");
      if (uiObjectProperties.test(propertyName)) {
        const text = expressionText(node.initializer, sourceFile);
        if (text !== null) add(`property:${propertyName}`, node.initializer, text);
      }
    }

    if (ts.isParameter(node) && ts.isIdentifier(node.name) && uiObjectProperties.test(node.name.text) && node.initializer) {
      const text = expressionText(node.initializer, sourceFile);
      if (text !== null) add(`parameter:${node.name.text}`, node.initializer, text);
    }

    if (ts.isCallExpression(node) && userFeedbackCalls.test(callName(node.expression))) {
      for (const argument of node.arguments) {
        const text = expressionText(argument, sourceFile);
        if (text !== null) add(`feedback:${callName(node.expression)}`, argument, text);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

const files = scanRoots.flatMap(walkFiles)
  .filter((filePath) => !skippedFilePatterns.some((pattern) => pattern.test(filePath)))
  .sort();
const findings = files.flatMap(scanFile);
const unique = new Map();

for (const finding of findings) {
  const existing = unique.get(finding.text);
  if (existing) existing.occurrences.push({ file: finding.file, line: finding.line, kind: finding.kind });
  else unique.set(finding.text, { text: finding.text, occurrences: [{ file: finding.file, line: finding.line, kind: finding.kind }] });
}

const result = [...unique.values()].sort((left, right) => left.text.localeCompare(right.text));
const jsonMode = process.argv.includes("--json");
const checkMode = process.argv.includes("--check");

function flattenStrings(value, result = new Set()) {
  if (typeof value === "string") result.add(value);
  else if (value && typeof value === "object") {
    for (const nested of Object.values(value)) flattenStrings(nested, result);
  }
  return result;
}

if (checkMode) {
  const localeRoot = path.join(uiRoot, "i18n", "locales");
  const keyedEnglish = flattenStrings(JSON.parse(fs.readFileSync(path.join(localeRoot, "en.json"), "utf8")));
  const legacyChinese = {
    ...JSON.parse(fs.readFileSync(path.join(uiRoot, "i18n", "legacy-zh-CN.json"), "utf8")),
    ...JSON.parse(fs.readFileSync(path.join(uiRoot, "i18n", "legacy-zh-CN.overrides.json"), "utf8")),
  };
  const uncovered = result.filter(({ text }) => !keyedEnglish.has(text) && typeof legacyChinese[text] !== "string");
  const placeholderMismatches = Object.entries(legacyChinese).filter(([english, chinese]) => {
    const source = [...english.matchAll(/{{value\d+}}/g)].map((match) => match[0]).sort();
    const target = [...chinese.matchAll(/{{value\d+}}/g)].map((match) => match[0]).sort();
    return source.join("\0") !== target.join("\0");
  });

  if (uncovered.length || placeholderMismatches.length) {
    console.error(`i18n audit failed: ${uncovered.length} uncovered phrases, ${placeholderMismatches.length} placeholder mismatches.`);
    for (const entry of uncovered.slice(0, 100)) {
      const first = entry.occurrences[0];
      console.error(`${first.file}:${first.line}\t${entry.text}`);
    }
    for (const [english, chinese] of placeholderMismatches.slice(0, 20)) {
      console.error(`Placeholder mismatch: ${english} => ${chinese}`);
    }
    process.exit(1);
  }

  console.log(`i18n audit passed: ${files.length} TypeScript files, ${result.length} unique UI phrases, 0 uncovered.`);
  process.exit(0);
}

if (jsonMode) {
  process.stdout.write(`${JSON.stringify({ files: files.length, occurrences: findings.length, phrases: result }, null, 2)}\n`);
} else {
  console.log(`Scanned ${files.length} TypeScript files: ${findings.length} occurrences, ${result.length} unique English UI phrases.`);
  for (const entry of result) {
    const first = entry.occurrences[0];
    console.log(`${first.file}:${first.line}\t${first.kind}\t${entry.text}`);
  }
}
