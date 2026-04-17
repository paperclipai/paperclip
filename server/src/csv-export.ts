/**
 * CSV export utilities for cost and finance data
 */

export function escapeCSVField(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const stringValue = String(value);

  // If the field contains comma, quote, or newline, wrap it in quotes and escape internal quotes
  if (stringValue.includes(",") || stringValue.includes('"') || stringValue.includes("\n")) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

export function arrayToCSV<T extends Record<string, unknown>>(
  data: T[],
  headers?: string[]
): string {
  if (data.length === 0) {
    return headers ? headers.join(",") + "\n" : "";
  }

  const keys = headers || (Object.keys(data[0]) as Array<keyof T>);
  const headerRow = keys.map((key) => escapeCSVField(key)).join(",");

  const rows = data.map((row) =>
    keys.map((key) => escapeCSVField(row[key as string])).join(",")
  );

  return [headerRow, ...rows].join("\n") + "\n";
}
