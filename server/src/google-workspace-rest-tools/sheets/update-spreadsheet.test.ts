import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { BATCH_UPDATE_RESPONSE, SPREADSHEET_ID } from "./fixtures/sheets-rest.js";
import {
  COMMENT_REQUESTS,
  DATA_SOURCE_REQUESTS,
  describeRequest,
  REQUEST_TARGETS,
  SUPPORTED_REQUESTS,
  updateSpreadsheet,
  updateSpreadsheetRequest,
  updateSpreadsheetStatus,
} from "./update-spreadsheet.js";

const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
const grid = { sheetId: 0, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 };
const cellRow = (count: number) => ({ values: Array.from({ length: count }, () => ({ userEnteredValue: { numberValue: 1 } })) });

describe("update_spreadsheet operations", () => {
  it("supports exactly the operations Google's reference lists, less comments and data sources", () => {
    expect(SUPPORTED_REQUESTS).toHaveLength(64);
    for (const kind of [...COMMENT_REQUESTS, ...DATA_SOURCE_REQUESTS]) expect(SUPPORTED_REQUESTS).not.toContain(kind);
  });

  it.each(SUPPORTED_REQUESTS.map((kind) => [kind]))("accepts %s", (kind) => {
    expect(() => updateSpreadsheetRequest({ spreadsheetId: SPREADSHEET_ID, requests: [{ [kind]: {} }] })).not.toThrow();
  });

  it.each([
    [[{ insertComment: {} }], /insertComment is not available here; comments/],
    [[{ updateCells: {} }, { deleteCommentReply: {} }], /Request 2: deleteCommentReply is not available/],
    [[{ addDataSource: {} }], /data sources need BigQuery access/],
    [[{ refreshDataSource: {} }], /data sources/],
    [[{ deleteSpreadsheet: {} }], /deleteSpreadsheet is not a supported operation/],
    [[{ updateDriveSharing: {} }], /not a supported operation/],
    [[{ mergeCells: {}, unmergeCells: {} }], /exactly one operation.* it has 2/],
    [[{}], /exactly one operation/],
    [[{ mergeCells: "A1:B2" }], /mergeCells must be an object/],
    [[{ mergeCells: [] }], /must be an object/],
  ])("refuses %j", (requests, message) => {
    expect(() => updateSpreadsheetRequest({ spreadsheetId: SPREADSHEET_ID, requests })).toThrow(message);
  });

  it("refuses writeControl, which the Sheets API cannot honor", () => {
    expect(() => updateSpreadsheetRequest({ spreadsheetId: SPREADSHEET_ID, requests: [{ addSheet: {} }], writeControl: { requiredRevisionId: "r1" } }))
      .toThrow(/writeControl is not available/);
  });

  it("bounds the cells updateCells and appendCells write", () => {
    const requests = [
      { updateCells: { start: { sheetId: 0, rowIndex: 0, columnIndex: 0 }, rows: Array.from({ length: 500 }, () => cellRow(50)), fields: "userEnteredValue" } },
      { appendCells: { sheetId: 0, rows: Array.from({ length: 501 }, () => cellRow(50)), fields: "userEnteredValue" } },
    ];
    expect(() => updateSpreadsheetRequest({ spreadsheetId: SPREADSHEET_ID, requests })).toThrow(/50,050 cells; the limit is 50,000/);
  });

  it("sends the requests unchanged in one batchUpdate", () => {
    const requests = [{ mergeCells: { range: grid, mergeType: "MERGE_ALL" } }, { addSheet: { properties: { title: "Notes" } } }];
    expect(updateSpreadsheetRequest({ spreadsheetId: SPREADSHEET_ID, requests })).toEqual({
      method: "POST", host: "sheets.googleapis.com", path: `/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`, body: { requests },
    });
  });
});

describe("update_spreadsheet status", () => {
  it.each([
    [{ updateCells: { range: grid, rows: [cellRow(3), cellRow(3)], fields: "userEnteredValue" } }, "1. updateCells on sheet ID 0, rows 1–2, columns A–C (6 cells written)"],
    [{ updateCells: { start: { sheetId: 3, rowIndex: 4, columnIndex: 1 }, rows: [cellRow(1)], fields: "*" } }, "1. updateCells on sheet ID 3, rows 5 onward, columns B onward (1 cell written)"],
    [{ appendCells: { sheetId: 2, rows: [cellRow(2)], fields: "userEnteredValue" } }, "1. appendCells on sheet ID 2 (2 cells written)"],
    [{ deleteDimension: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 1, endIndex: 3 } } }, "1. deleteDimension on sheet ID 0, columns B–C"],
    [{ deleteSheet: { sheetId: 9 } }, "1. deleteSheet on sheet ID 9"],
    [{ duplicateSheet: { sourceSheetId: 4, newSheetName: "Copy" } }, "1. duplicateSheet on sheet ID 4"],
    [{ updateSheetProperties: { properties: { sheetId: 5, title: "Renamed" }, fields: "title" } }, "1. updateSheetProperties on sheet ID 5"],
    [{ copyPaste: { source: grid, destination: { ...grid, sheetId: 1 } } }, "1. copyPaste on sheet ID 0, rows 1–2, columns A–C to sheet ID 1, rows 1–2, columns A–C"],
    [{ cutPaste: { source: grid, destination: { sheetId: 0, rowIndex: 9, columnIndex: 3 } } }, "1. cutPaste on sheet ID 0, rows 1–2, columns A–C to sheet ID 0, rows 10 onward, columns D onward"],
    [{ moveDimension: { source: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 2 }, destinationIndex: 7 } }, "1. moveDimension on sheet ID 0, row 2 to 0-based index 7"],
    [{ pasteData: { coordinate: { sheetId: 0, rowIndex: 0, columnIndex: 0 }, data: "a,b", delimiter: "," } }, "1. pasteData on sheet ID 0, rows 1 onward, columns A onward"],
    [{ autoResizeDimensions: { dimensions: { sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: 10 } } }, "1. autoResizeDimensions on sheet ID 0, rows 1–10"],
  ])("%j", (request, description) => {
    expect(describeRequest(request, 0)).toBe(description);
  });

  it("has a target entry for every supported request type, and none for anything else", () => {
    expect(Object.keys(REQUEST_TARGETS).sort()).toEqual([...SUPPORTED_REQUESTS].sort());
    for (const kind of SUPPORTED_REQUESTS) expect(REQUEST_TARGETS[kind].length, kind).toBeGreaterThan(0);
  });

  it.each([
    [{ addNamedRange: { namedRange: { name: "Totals", range: grid } } }, "1. addNamedRange on sheet ID 0, rows 1–2, columns A–C"],
    [{ updateNamedRange: { namedRange: { namedRangeId: "nr1", range: grid }, fields: "range" } }, "1. updateNamedRange on namedRangeId nr1 and sheet ID 0, rows 1–2, columns A–C"],
    [{ deleteNamedRange: { namedRangeId: "nr1" } }, "1. deleteNamedRange on namedRangeId nr1"],
    [{ addProtectedRange: { protectedRange: { range: grid, description: "Locked" } } }, "1. addProtectedRange on sheet ID 0, rows 1–2, columns A–C"],
    [{ updateProtectedRange: { protectedRange: { protectedRangeId: 4, warningOnly: true }, fields: "warningOnly" } }, "1. updateProtectedRange on protectedRangeId 4"],
    [{ addConditionalFormatRule: { rule: { ranges: [grid, { ...grid, sheetId: 2 }] }, index: 0 } }, "1. addConditionalFormatRule on sheet ID 0, rows 1–2, columns A–C and sheet ID 2, rows 1–2, columns A–C"],
    [{ deleteConditionalFormatRule: { sheetId: 1, index: 3 } }, "1. deleteConditionalFormatRule on sheet ID 1 and rule index 3"],
    [{ findReplace: { find: "a", replacement: "b", allSheets: true } }, "1. findReplace on all sheets"],
    [{ findReplace: { find: "a", replacement: "b", sheetId: 6 } }, "1. findReplace on sheet ID 6"],
    [{ addFilterView: { filter: { title: "Open", range: grid } } }, "1. addFilterView on sheet ID 0, rows 1–2, columns A–C"],
    [{ setBasicFilter: { filter: { range: grid } } }, "1. setBasicFilter on sheet ID 0, rows 1–2, columns A–C"],
    [{ addBanding: { bandedRange: { range: grid } } }, "1. addBanding on sheet ID 0, rows 1–2, columns A–C"],
    [{ updateDimensionGroup: { dimensionGroup: { range: { sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: 4 } }, fields: "collapsed" } }, "1. updateDimensionGroup on sheet ID 0, rows 1–4"],
    [{ addChart: { chart: { position: { overlayPosition: { anchorCell: { sheetId: 3, rowIndex: 1, columnIndex: 1 } } } } } }, "1. addChart on sheet ID 3, rows 2 onward, columns B onward"],
    [{ addTable: { table: { name: "T", range: grid } } }, "1. addTable on sheet ID 0, rows 1–2, columns A–C"],
    [{ deleteTable: { tableId: "t1" } }, "1. deleteTable on tableId t1"],
    [{ autoFill: { sourceAndDestination: { source: grid, dimension: "ROWS", fillLength: 3 } } }, "1. autoFill on sheet ID 0, rows 1–2, columns A–C"],
    [{ createDeveloperMetadata: { developerMetadata: { metadataKey: "k", location: { sheetId: 2 } } } }, "1. createDeveloperMetadata on sheet ID 2"],
    [{ createDeveloperMetadata: { developerMetadata: { metadataKey: "k", location: { spreadsheet: true } } } }, "1. createDeveloperMetadata on the spreadsheet"],
    [{ deleteDeveloperMetadata: { dataFilter: {} } }, "1. deleteDeveloperMetadata on matching developer metadata"],
    [{ updateSpreadsheetProperties: { properties: { title: "Budget" }, fields: "title" } }, "1. updateSpreadsheetProperties on the spreadsheet's properties"],
    [{ addSheet: { properties: { title: "Notes" } } }, "1. addSheet on title Notes"],
    [{ appendDimension: { sheetId: 0, dimension: "ROWS", length: 5 } }, "1. appendDimension on sheet ID 0"],
  ])("names the nested range of %j", (request, description) => {
    expect(describeRequest(request, 0)).toBe(description);
  });

  it("lists every request", () => {
    expect(updateSpreadsheetStatus([{ deleteSheet: { sheetId: 9 } }, { addSheet: { properties: { title: "New" } } }]))
      .toBe("Applied 2 requests: 1. deleteSheet on sheet ID 9; 2. addSheet on title New.");
  });
});

describe("update_spreadsheet tool", () => {
  it("applies the requests once and returns Google's answer with the status", async () => {
    const { fetch, calls } = fakeGoogle(() => json(BATCH_UPDATE_RESPONSE));
    const requests = [{ repeatCell: { range: grid, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } }];
    const result = await updateSpreadsheet.call({ spreadsheetId: SPREADSHEET_ID, requests }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ requests });
    expect(result.structuredContent).toEqual({ content: { ...BATCH_UPDATE_RESPONSE, status: "Applied 1 request: 1. repeatCell on sheet ID 0, rows 1–2, columns A–C." } });
  });

  it("never retries and warns the update may have happened", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ error: { code: 502 } }, 502));
    const result = await updateSpreadsheet.call({ spreadsheetId: SPREADSHEET_ID, requests: [{ addSheet: {} }] }, createGoogleHttp({ accessToken: "t", fetch, retryDelayMs: 0 }));
    expect(calls).toHaveLength(1);
    expect(text(result)).toMatch(/may or may not have been made/);
  });

  it.each([
    [{ requests: [] }, /requests/],
    [{ requests: [{ insertComment: {} }] }, /comments/],
    [{ requests: [{ addSheet: {} }], writeControl: {} }, /writeControl/],
    [{ requests: Array.from({ length: 501 }, () => ({ addSheet: {} })) }, /requests/],
  ])("refuses %j without sending", async (args, message) => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const result = await updateSpreadsheet.call({ spreadsheetId: SPREADSHEET_ID, ...args }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(message);
    expect(calls).toHaveLength(0);
  });
});
