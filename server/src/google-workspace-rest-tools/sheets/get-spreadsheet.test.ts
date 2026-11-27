import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { SPREADSHEET_ID, SPREADSHEET_METADATA, SPREADSHEET_WITH_GRID } from "./fixtures/sheets-rest.js";
import { serializedResultBytes } from "../tool.js";
import { getSpreadsheet, getSpreadsheetRequest, getSpreadsheetResult, gridCellCount } from "./get-spreadsheet.js";

const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

describe("get_spreadsheet request", () => {
  it.each([
    [{ spreadsheetId: SPREADSHEET_ID }, { includeGridData: false, ranges: undefined, fields: undefined }],
    [{ spreadsheetId: SPREADSHEET_ID, includeGridData: true, ranges: ["'Q1 Plan'!A1:B2", "Sheet2"] },
      { includeGridData: true, ranges: ["'Q1 Plan'!A1:B2", "Sheet2"], fields: undefined }],
    [{ spreadsheetId: SPREADSHEET_ID, fields: ["sheets.properties.sheetId", "sheets.properties.title"] },
      { includeGridData: false, ranges: undefined, fields: "sheets.properties.sheetId,sheets.properties.title" }],
    [{ spreadsheetId: SPREADSHEET_ID, fields: [], ranges: [], commentsIncluded: false }, { includeGridData: false, ranges: undefined, fields: undefined }],
  ])("%j", (input, query) => {
    expect(getSpreadsheetRequest(input)).toEqual({ method: "GET", host: "sheets.googleapis.com", path: `/v4/spreadsheets/${SPREADSHEET_ID}`, query });
  });

  it.each([
    "sheets.properties.title",
    "sheets.properties(sheetId,title)",
    "sheets(properties(sheetId,title),merges)",
    "spreadsheetId,properties.title",
    "sheets/properties/title",
    "sheets.data.rowData.values(formattedValue,effectiveValue)",
    "*",
    "sheets.properties.*",
  ])("accepts the field mask %s and sends it unchanged", async (mask) => {
    const { fetch, calls } = fakeGoogle(() => json(SPREADSHEET_METADATA));
    const result = await getSpreadsheet.call({ spreadsheetId: SPREADSHEET_ID, fields: [mask, "spreadsheetId"] }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBeFalsy();
    expect(calls[0]!.url.searchParams.get("fields")).toBe(`${mask},spreadsheetId`);
    expect([...calls[0]!.url.searchParams.keys()].sort()).toEqual(["fields", "includeGridData"]);
  });

  it.each([
    "sheets.properties.title&key=x",
    "sheets.properties.title=x",
    "sheets.properties%2Ctitle",
    "sheets.properties.title\nx",
    "sheets. properties",
    " sheets",
    "sheets\tproperties",
    "sheets.properties(sheetId,title",
    "sheets.properties)sheetId(",
    "sheets#x",
    "sheets?x",
    "sheets;x",
    "",
    "x".repeat(1_001),
  ])("refuses the field mask %j without sending", async (mask) => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const result = await getSpreadsheet.call({ spreadsheetId: SPREADSHEET_ID, fields: [mask] }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/field mask/);
    expect(calls).toHaveLength(0);
  });

  it("sends each range as its own ranges parameter", async () => {
    const { fetch, calls } = fakeGoogle(() => json(SPREADSHEET_METADATA));
    await getSpreadsheet.call({ spreadsheetId: SPREADSHEET_ID, ranges: ["Sheet1!A1:B2", "'Q1 Plan'!C:C"] }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls[0]!.url.searchParams.getAll("ranges")).toEqual(["Sheet1!A1:B2", "'Q1 Plan'!C:C"]);
    expect(calls[0]!.url.searchParams.get("includeGridData")).toBe("false");
  });
});

describe("get_spreadsheet result", () => {
  it("returns the Spreadsheet resource as content, with cell data, dates as serial numbers and merges unchanged", () => {
    const result = getSpreadsheetResult(SPREADSHEET_WITH_GRID);
    expect(result.structuredContent).toEqual({ content: SPREADSHEET_WITH_GRID });
    expect(gridCellCount(SPREADSHEET_WITH_GRID)).toBe(3);
  });

  it("bounds the whole serialized result in bytes and asks for fewer or narrower ranges", async () => {
    const sheet = (note: string) => ({ properties: { title: note } });
    const call = (title: string) => getSpreadsheet.call({ spreadsheetId: SPREADSHEET_ID }, createGoogleHttp({ accessToken: "t", fetch: fakeGoogle(() => json({ sheets: [sheet(title)] })).fetch }));
    const near = await call("x".repeat(124_900));
    expect(near.isError).toBeUndefined();
    expect(serializedResultBytes(near)).toBeLessThanOrEqual(250_000);
    expect(text(await call("x".repeat(125_000)))).toMatch(/bytes, more than the 250,000 bytes this tool can return, so it was not returned\. Pass fewer or narrower ranges/);
  });

  it("refuses a result over the cell limit instead of cutting it", () => {
    const big = { sheets: [{ data: [{ rowData: Array.from({ length: 1_001 }, () => ({ values: Array.from({ length: 50 }, () => ({})) })) }] }] };
    expect(() => getSpreadsheetResult(big)).toThrow(/50,050 cells; the limit is 50,000 per call\. Pass fewer or narrower ranges/);
  });
});

describe("get_spreadsheet tool", () => {
  it("reads metadata", async () => {
    const { fetch } = fakeGoogle(() => json(SPREADSHEET_METADATA));
    const result = await getSpreadsheet.call({ spreadsheetId: SPREADSHEET_ID }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.structuredContent).toEqual({ content: SPREADSHEET_METADATA });
  });

  it.each([
    [{ spreadsheetId: SPREADSHEET_ID, commentsIncluded: true }, /Comments are not available/],
    [{ spreadsheetId: SPREADSHEET_ID, ranges: ["Q1 Plan!A1"] }, /must be quoted/],
    [{ spreadsheetId: SPREADSHEET_ID, ranges: Array.from({ length: 101 }, () => "A1") }, /ranges/],
    [{ spreadsheetId: "a/b" }, /spreadsheet ID/],
  ])("refuses %j without sending", async (args, message) => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const result = await getSpreadsheet.call(args, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(message);
    expect(calls).toHaveLength(0);
  });
});
