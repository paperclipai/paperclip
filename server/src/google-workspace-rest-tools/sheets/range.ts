export const MAX_COLUMN = 18_278;
export const MAX_ROW = 10_000_000;
export const MAX_RANGE_LENGTH = 1_000;

export interface SheetRange {
  sheet?: string;
  cells?: string;
}

export type RangeCheck = { ok: true; range: SheetRange } | { ok: false; message: string };

const UNQUOTED_NAME = /^[\p{L}\p{N}_]+$/u;
const A1_PART = /^(\$?([A-Za-z]{1,3}))?(\$?([1-9]\d{0,7}))?$/;
const R1C1 = /^R([1-9]\d{0,7})C([1-9]\d{0,4})(?::R([1-9]\d{0,7})C([1-9]\d{0,4}))?$/i;
const QUOTING_HINT = "Put a sheet name with spaces or punctuation in single quotes and double any apostrophe, for example 'Q1 Plan'!A1:B2 or 'Bob''s list'!A:A.";

export function columnNumber(letters: string): number {
  return [...letters.toUpperCase()].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
}

export function columnLetters(index: number): string {
  let letters = "";
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }
  return letters;
}

interface A1Part { column?: number; row?: number }

function a1Part(text: string): A1Part | null {
  const match = A1_PART.exec(text);
  if (!match || text.length === 0) return null;
  return {
    column: match[2] ? columnNumber(match[2]) : undefined,
    row: match[4] ? Number(match[4]) : undefined,
  };
}

function inBounds(part: A1Part): boolean {
  return (part.column ?? 1) <= MAX_COLUMN && (part.row ?? 1) <= MAX_ROW;
}

export function isCellReference(text: string): boolean {
  const r1c1 = R1C1.exec(text);
  if (r1c1) return [r1c1[1], r1c1[3]].every((row) => row === undefined || Number(row) <= MAX_ROW)
    && [r1c1[2], r1c1[4]].every((column) => column === undefined || Number(column) <= MAX_COLUMN);
  const pieces = text.split(":");
  if (pieces.length > 2) return false;
  const parts = pieces.map(a1Part);
  if (parts.some((part) => part === null || !inBounds(part))) return false;
  const [start, end] = parts as A1Part[];
  if (!end) return start!.column !== undefined && start!.row !== undefined;
  const bothColumns = start!.column !== undefined && end.column !== undefined;
  const bothRows = start!.row !== undefined && end.row !== undefined;
  return bothColumns || bothRows;
}

function checkCells(cells: string, sheet: string | undefined): RangeCheck {
  if (!isCellReference(cells)) {
    return { ok: false, message: `"${cells}" is not a cell range. Use A1 notation (A1, A1:C10, A:C, 2:5, A2:C) or R1C1 notation (R1C1:R10C3).` };
  }
  return { ok: true, range: { sheet, cells } };
}

export function checkSheetRange(text: string): RangeCheck {
  if (text.length === 0) return { ok: false, message: "The range is empty." };
  if (text.length > MAX_RANGE_LENGTH) return { ok: false, message: `The range is longer than ${MAX_RANGE_LENGTH} characters.` };
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, message: "The range contains a line break or control character." };
  if (text !== text.trim()) return { ok: false, message: "The range starts or ends with a space." };

  if (text.startsWith("'")) {
    let name = "";
    let index = 1;
    for (; index < text.length; index += 1) {
      if (text[index] !== "'") {
        name += text[index];
        continue;
      }
      if (text[index + 1] === "'") {
        name += "'";
        index += 1;
        continue;
      }
      break;
    }
    if (index >= text.length) return { ok: false, message: `The quoted sheet name is not closed. ${QUOTING_HINT}` };
    if (name.length === 0) return { ok: false, message: "The sheet name is empty." };
    const rest = text.slice(index + 1);
    if (rest.length === 0) return { ok: true, range: { sheet: name } };
    if (!rest.startsWith("!") || rest.length === 1) return { ok: false, message: `Expected ! and a cell range after the quoted sheet name. ${QUOTING_HINT}` };
    return checkCells(rest.slice(1), name);
  }

  const bang = text.indexOf("!");
  if (bang === -1) {
    if (isCellReference(text)) return { ok: true, range: { cells: text } };
    if (UNQUOTED_NAME.test(text)) return { ok: true, range: { sheet: text } };
    return { ok: false, message: `"${text}" is neither a cell range nor a plain sheet name. ${QUOTING_HINT}` };
  }
  const sheet = text.slice(0, bang);
  if (sheet.length === 0) return { ok: false, message: "The sheet name before ! is empty." };
  if (!UNQUOTED_NAME.test(sheet)) return { ok: false, message: `The sheet name ${sheet} must be quoted. ${QUOTING_HINT}` };
  const cells = text.slice(bang + 1);
  if (cells.length === 0) return { ok: false, message: "Expected a cell range after !." };
  return checkCells(cells, sheet);
}

export function quoteSheetName(name: string): string {
  if (UNQUOTED_NAME.test(name) && !isCellReference(name) && !/^\d+$/.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

export function formatSheetRange(range: SheetRange): string {
  if (range.sheet === undefined) return range.cells ?? "";
  return range.cells === undefined ? quoteSheetName(range.sheet) : `${quoteSheetName(range.sheet)}!${range.cells}`;
}

export interface GridRange {
  sheetId?: number;
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
}

export interface DimensionRange {
  sheetId?: number;
  dimension?: string;
  startIndex?: number;
  endIndex?: number;
}

function span(start: number | undefined, end: number | undefined, label: (index: number) => string, plural: string): string {
  if (start === undefined && end === undefined) return `all ${plural}`;
  const first = label(start ?? 0);
  if (end === undefined) return `${plural} ${first} onward`;
  const last = label(end - 1);
  return first === last ? `${plural.replace(/s$/, "")} ${first}` : `${plural} ${first}–${last}`;
}

const rowLabel = (index: number) => String(index + 1);

export function describeGridRange(range: GridRange): string {
  return [
    `sheet ID ${range.sheetId ?? 0}`,
    span(range.startRowIndex, range.endRowIndex, rowLabel, "rows"),
    span(range.startColumnIndex, range.endColumnIndex, columnLetters, "columns"),
  ].join(", ");
}

export function describeDimensionRange(range: DimensionRange): string {
  const columns = range.dimension === "COLUMNS";
  return `sheet ID ${range.sheetId ?? 0}, ${span(range.startIndex, range.endIndex, columns ? columnLetters : rowLabel, columns ? "columns" : "rows")}`;
}
