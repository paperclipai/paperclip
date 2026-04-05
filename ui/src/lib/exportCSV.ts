/**
 * Export any array of objects to a downloadable CSV file.
 *
 * @param data  - Array of flat objects (each key becomes a column header)
 * @param filename - Name for the downloaded file (without extension)
 * @param columns - Optional ordered list of { key, label } to control which
 *                  columns are exported and in what order. If omitted, all keys
 *                  from the first row are used as-is.
 */
export function exportToCSV(
  data: Record<string, unknown>[],
  filename: string,
  columns?: Array<{ key: string; label: string }>,
): void {
  if (data.length === 0) return;

  const cols = columns ?? Object.keys(data[0]).map((k) => ({ key: k, label: k }));

  const escape = (val: unknown): string => {
    if (val === null || val === undefined) return "";
    const str = String(val);
    // Wrap in quotes if the value contains commas, quotes, or newlines
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const header = cols.map((c) => escape(c.label)).join(",");
  const rows = data.map((row) =>
    cols.map((c) => escape(row[c.key])).join(","),
  );

  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}.csv`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
