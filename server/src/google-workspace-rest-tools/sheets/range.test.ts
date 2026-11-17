import { describe, expect, it } from "vitest";
import {
  checkSheetRange,
  columnLetters,
  columnNumber,
  describeDimensionRange,
  describeGridRange,
  formatSheetRange,
  quoteSheetName,
} from "./range.js";

describe("checkSheetRange accepts", () => {
  it.each([
    ["A1", { cells: "A1" }],
    ["a1:c10", { cells: "a1:c10" }],
    ["Sheet1", { sheet: "Sheet1" }],
    ["Sheet1!A1:B2", { sheet: "Sheet1", cells: "A1:B2" }],
    ["Sheet1!A:C", { sheet: "Sheet1", cells: "A:C" }],
    ["Sheet1!2:5", { sheet: "Sheet1", cells: "2:5" }],
    ["Sheet1!A2:C", { sheet: "Sheet1", cells: "A2:C" }],
    ["Sheet1!A5:A", { sheet: "Sheet1", cells: "A5:A" }],
    ["Sheet1!$A$1:$B$2", { sheet: "Sheet1", cells: "$A$1:$B$2" }],
    ["Sheet1!B2:A1", { sheet: "Sheet1", cells: "B2:A1" }],
    ["Sheet1!ZZZ10000000", { sheet: "Sheet1", cells: "ZZZ10000000" }],
    ["Sheet1!R1C1:R10C3", { sheet: "Sheet1", cells: "R1C1:R10C3" }],
    ["R2C2", { cells: "R2C2" }],
    ["'Q1 Plan'!A1:B2", { sheet: "Q1 Plan", cells: "A1:B2" }],
    ["'Bob''s list'!A:A", { sheet: "Bob's list", cells: "A:A" }],
    ["'''quoted'''!A1", { sheet: "'quoted'", cells: "A1" }],
    ["'Q1 Plan'", { sheet: "Q1 Plan" }],
    ["'Sales!2026'!C3", { sheet: "Sales!2026", cells: "C3" }],
    ["Données!A1", { sheet: "Données", cells: "A1" }],
    ["売上!B2:C3", { sheet: "売上", cells: "B2:C3" }],
    ["Budget_2026", { sheet: "Budget_2026" }],
  ])("%s", (text, range) => {
    expect(checkSheetRange(text)).toEqual({ ok: true, range });
  });
});

describe("checkSheetRange refuses", () => {
  it.each([
    ["", /empty/],
    [" Sheet1!A1", /space/],
    ["Sheet1!A1 ", /space/],
    ["Sheet1!A1\nB2", /line break/],
    ["Q1 Plan!A1", /must be quoted/],
    ["Bob's list!A1", /must be quoted/],
    ["Q1 Plan", /neither a cell range nor a plain sheet name/],
    ["'Q1 Plan!A1", /not closed/],
    ["'Q1 Plan'A1", /Expected !/],
    ["'Q1 Plan'!", /Expected !/],
    ["''!A1", /sheet name is empty/],
    ["!A1", /before ! is empty/],
    ["Sheet1!", /after !/],
    ["Sheet1!A", /not a cell range/],
    ["Sheet1!1", /not a cell range/],
    ["Sheet1!A:1", /not a cell range/],
    ["Sheet1!A1:B2:C3", /not a cell range/],
    ["Sheet1!A0", /not a cell range/],
    ["Sheet1!AAAA1", /not a cell range/],
    ["Sheet1!ZZZ10000001", /not a cell range/],
    ["Sheet1!A1,B2", /not a cell range/],
    ["Sheet1!R0C1", /not a cell range/],
    ["..", /neither/],
    ["Sheet1!../x", /not a cell range/],
    ["x".repeat(1001), /longer than 1000/],
  ])("%j", (text, message) => {
    const check = checkSheetRange(text);
    expect(check.ok).toBe(false);
    expect(check.ok ? "" : check.message).toMatch(message);
  });

  it("explains how to quote a sheet name", () => {
    const check = checkSheetRange("Q1 Plan!A1");
    expect(check.ok ? "" : check.message).toContain("'Q1 Plan'!A1:B2");
  });
});

describe("quoteSheetName", () => {
  it.each([
    ["Sheet1", "Sheet1"],
    ["Budget_2026", "Budget_2026"],
    ["Données", "Données"],
    ["Q1 Plan", "'Q1 Plan'"],
    ["Bob's list", "'Bob''s list'"],
    ["Sales!2026", "'Sales!2026'"],
    ["A1", "'A1'"],
    ["R1C1", "'R1C1'"],
    ["2026", "'2026'"],
    ["a-b", "'a-b'"],
  ])("%s -> %s", (name, quoted) => {
    expect(quoteSheetName(name)).toBe(quoted);
  });

  it.each(["Q1 Plan", "Bob's list", "'quoted'", "Sales!2026", "A1"])("round-trips %s through checkSheetRange", (name) => {
    expect(checkSheetRange(formatSheetRange({ sheet: name, cells: "A1:B2" }))).toEqual({ ok: true, range: { sheet: name, cells: "A1:B2" } });
  });
});

describe("columns", () => {
  it.each([[0, "A"], [25, "Z"], [26, "AA"], [701, "ZZ"], [702, "AAA"], [18_277, "ZZZ"]])("%i is %s", (index, letters) => {
    expect(columnLetters(index)).toBe(letters);
    expect(columnNumber(letters)).toBe(index + 1);
  });
});

describe("describing grid and dimension ranges", () => {
  it.each([
    [{ sheetId: 0, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 }, "sheet ID 0, rows 1–2, columns A–C"],
    [{ sheetId: 4, startRowIndex: 9, endRowIndex: 10, startColumnIndex: 27, endColumnIndex: 28 }, "sheet ID 4, row 10, column AB"],
    [{ sheetId: 4 }, "sheet ID 4, all rows, all columns"],
    [{ sheetId: 1, startRowIndex: 5 }, "sheet ID 1, rows 6 onward, all columns"],
    [{}, "sheet ID 0, all rows, all columns"],
  ])("%j", (range, text) => {
    expect(describeGridRange(range)).toBe(text);
  });

  it.each([
    [{ sheetId: 0, dimension: "ROWS", startIndex: 5, endIndex: 8 }, "sheet ID 0, rows 6–8"],
    [{ sheetId: 2, dimension: "COLUMNS", startIndex: 2, endIndex: 3 }, "sheet ID 2, column C"],
  ])("%j", (range, text) => {
    expect(describeDimensionRange(range)).toBe(text);
  });
});
