const LONE_SURROGATE_RE =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/g;

export function toWellFormedSnippet(value: string, maxLength = 120): string {
  return value.slice(0, maxLength).replace(LONE_SURROGATE_RE, "\uFFFD");
}
