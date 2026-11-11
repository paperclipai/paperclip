export function isCsvFile(filename: string, contentType = "") {
  return /\.csv$/i.test(filename) || contentType.split(";")[0].trim().toLowerCase() === "text/csv";
}

/** Parse comma-separated records, preserving quoted newlines and escaped quotes. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  if (!source) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || field === "") quoted = !quoted;
      else field += char;
    } else if (!quoted && char === ",") {
      row.push(field); field = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      row.push(field); rows.push(row); row = []; field = "";
      if (char === "\r" && source[i + 1] === "\n") i++;
    } else field += char;
  }
  if (quoted) throw new Error("A quoted field is incomplete. Switch to raw view to inspect the file.");
  if (field !== "" || row.length || !/[\r\n]$/.test(source)) { row.push(field); rows.push(row); }
  return rows;
}
