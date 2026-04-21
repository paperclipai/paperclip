type QaDimensionKey =
  | "codeQuality"
  | "errorHandling"
  | "testCoverage"
  | "commentQuality"
  | "docsImpact";

export function formatQaState(value: string) {
  if (value === "na") return "N/A";
  if (value === "unknown") return "Unknown";
  return value.toUpperCase();
}

export function formatQaDimensionState(key: QaDimensionKey, value: string) {
  if (key === "docsImpact" && value === "na") return "No docs change";
  return formatQaState(value);
}
