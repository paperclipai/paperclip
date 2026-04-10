import * as ts from 'typescript';

function getPropertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  return undefined;
}

function unwrapExpression(node) {
  if (!node) {
    return undefined;
  }

  let current = node;
  while (
    ts.isAsExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function getObjectProperty(objectLiteral, propertyName) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    if (getPropertyName(property.name) === propertyName) {
      return unwrapExpression(property.initializer);
    }
  }

  return undefined;
}

function findCopyObjectLiteral(sourceFile) {
  let match;

  function visit(node) {
    if (match) {
      return;
    }

    if (ts.isObjectLiteralExpression(node)) {
      const english = getObjectProperty(node, 'en');
      const chinese = getObjectProperty(node, 'zh-CN');

      if (
        english
        && chinese
        && ts.isObjectLiteralExpression(english)
        && ts.isObjectLiteralExpression(chinese)
      ) {
        match = node;
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return match;
}

function flattenObjectLiteral(objectLiteral, prefix = '', entries = {}) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }

    const propertyName = getPropertyName(property.name);
    if (!propertyName) {
      continue;
    }

    const key = prefix ? `${prefix}.${propertyName}` : propertyName;
    const value = unwrapExpression(property.initializer);

    if (ts.isObjectLiteralExpression(value)) {
      flattenObjectLiteral(value, key, entries);
      continue;
    }

    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      entries[key] = value.text;
    }
  }

  return entries;
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\r\n/g, '\n');
}

export function extractCopyEntries(sourceText) {
  const sourceFile = ts.createSourceFile('copy-helper.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const copyObject = findCopyObjectLiteral(sourceFile);

  if (!copyObject) {
    throw new Error('Could not find copy helper en/zh-CN tables');
  }

  const english = getObjectProperty(copyObject, 'en');
  const chinese = getObjectProperty(copyObject, 'zh-CN');

  if (!ts.isObjectLiteralExpression(english) || !ts.isObjectLiteralExpression(chinese)) {
    throw new Error('Copy helper locales must be object literals');
  }

  return {
    english: flattenObjectLiteral(english),
    chinese: flattenObjectLiteral(chinese),
  };
}

export function diffCopyResource({ resourcePath, baselineEnglish = {}, english = {}, chinese = {} }) {
  const missing = [];
  const changed = [];
  const stale = [];

  for (const key of Object.keys(english).sort()) {
    if (!Object.hasOwn(chinese, key)) {
      missing.push({
        key,
        english: english[key],
      });
      continue;
    }

    if (Object.hasOwn(baselineEnglish, key) && baselineEnglish[key] !== english[key]) {
      changed.push({
        key,
        baselineEnglish: baselineEnglish[key],
        english: english[key],
        chinese: chinese[key],
      });
    }
  }

  for (const key of Object.keys(chinese).sort()) {
    if (!Object.hasOwn(english, key)) {
      stale.push({
        key,
        chinese: chinese[key],
        baselineEnglish: Object.hasOwn(baselineEnglish, key) ? baselineEnglish[key] : undefined,
      });
    }
  }

  return {
    resourcePath,
    missing,
    changed,
    stale,
    hasDiff: missing.length > 0 || changed.length > 0 || stale.length > 0,
  };
}

export function diffMarkdownPair({
  englishPath,
  chinesePath,
  baselineEnglish = '',
  english = '',
  chinese = '',
}) {
  const localizedMissing = normalizeText(chinese) === '';
  const englishChanged = normalizeText(baselineEnglish) !== normalizeText(english);

  return {
    englishPath,
    chinesePath,
    needsReview: localizedMissing || englishChanged,
    reason: localizedMissing ? 'missing-chinese' : englishChanged ? 'english-changed' : undefined,
  };
}
