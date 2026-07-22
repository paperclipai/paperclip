import en from "./locales/en.json";

const MAX_STRING_LENGTH = 2_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatPath(path: string[]) {
  return path.length > 0 ? path.join(".") : "<root>";
}

function interpolationPlaceholders(value: string) {
  return Array.from(value.matchAll(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g), (match) => match[1]).sort();
}

function hasRawHtml(value: string) {
  return /<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^>]*)?>/.test(value);
}

function hasEventHandlerAttribute(value: string) {
  return /\son[A-Za-z]+\s*=/i.test(value);
}

function urlsIn(value: string) {
  return Array.from(value.matchAll(/\bhttps?:\/\/[^\s<>"')]+/gi), (match) => match[0]).sort();
}

function hasBlockedData(value: string, englishValue: string) {
  const checks: Array<[boolean, boolean, string]> = [
    [/<script\b/i.test(value), /<script\b/i.test(englishValue), "<script"],
    [hasEventHandlerAttribute(value), hasEventHandlerAttribute(englishValue), "event-handler attribute"],
    [/\bjavascript\s*:/i.test(value), /\bjavascript\s*:/i.test(englishValue), "javascript:"],
    [/\bdata\s*:/i.test(value), /\bdata\s*:/i.test(englishValue), "data:"],
    [hasRawHtml(value), hasRawHtml(englishValue), "raw HTML tag"],
  ];

  const blocked = checks
    .filter(([candidateHas, englishHas]) => candidateHas && !englishHas)
    .map(([, , blockedPayload]) => blockedPayload);

  const englishUrls = new Set(urlsIn(englishValue));
  const unexpectedUrl = urlsIn(value).find((url) => !englishUrls.has(url));
  if (unexpectedUrl) blocked.push("unexpected URL");

  return blocked;
}

function validateString(path: string[], candidateValue: string, englishValue: string, errors: string[]) {
  const candidatePlaceholders = interpolationPlaceholders(candidateValue);
  const englishPlaceholders = interpolationPlaceholders(englishValue);
  if (candidatePlaceholders.join("\u0000") !== englishPlaceholders.join("\u0000")) {
    errors.push(
      `${formatPath(path)} interpolation placeholders must match English exactly: expected ${JSON.stringify(
        englishPlaceholders,
      )}, received ${JSON.stringify(candidatePlaceholders)}`,
    );
  }

  for (const blockedPayload of hasBlockedData(candidateValue, englishValue)) {
    errors.push(`${formatPath(path)} contains disallowed ${blockedPayload}`);
  }

  const relativeLimit = Math.max(englishValue.length * 4 + 64, englishValue.length + 128);
  const lengthLimit = Math.min(MAX_STRING_LENGTH, relativeLimit);
  if (candidateValue.length > lengthLimit) {
    errors.push(`${formatPath(path)} is too long: ${candidateValue.length} characters exceeds ${lengthLimit}`);
  }
}

function validateNode(path: string[], candidate: unknown, englishReference: unknown, errors: string[]) {
  if (typeof englishReference === "string") {
    if (typeof candidate !== "string") {
      errors.push(`${formatPath(path)} must be a string`);
      return;
    }
    validateString(path, candidate, englishReference, errors);
    return;
  }

  if (!isPlainObject(englishReference)) {
    errors.push(`${formatPath(path)} has unsupported English reference type`);
    return;
  }

  if (!isPlainObject(candidate)) {
    errors.push(`${formatPath(path)} must be an object`);
    return;
  }

  const englishKeys = Object.keys(englishReference).sort();
  const candidateKeys = Object.keys(candidate).sort();
  const missingKeys = englishKeys.filter((key) => !candidateKeys.includes(key));
  const extraKeys = candidateKeys.filter((key) => !englishKeys.includes(key));

  for (const key of missingKeys) {
    errors.push(`${formatPath([...path, key])} is missing`);
  }
  for (const key of extraKeys) {
    errors.push(`${formatPath([...path, key])} is not defined in English`);
  }

  for (const key of englishKeys) {
    if (key in candidate) {
      validateNode([...path, key], candidate[key], englishReference[key], errors);
    }
  }
}

export function validateLocaleMessages(candidate: unknown, englishReference: unknown = en) {
  const errors: string[] = [];
  validateNode([], candidate, englishReference, errors);
  return errors;
}

export function assertValidLocaleMessages(candidate: unknown, englishReference: unknown = en) {
  const errors = validateLocaleMessages(candidate, englishReference);
  if (errors.length > 0) {
    throw new Error(`Invalid locale messages:\n${errors.join("\n")}`);
  }
}
