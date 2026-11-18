import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { BATCH_UPDATE_RESPONSE, SPREADSHEET_ID } from "./fixtures/sheets-rest.js";
import { insertDimension, insertDimensionRequest, insertDimensionStatus } from "./insert-dimension.js";

const base = { spreadsheetId: SPREADSHEET_ID, sheetId: 0, dimension: "ROWS" as const, startIndex: 5, endIndex: 8 };
const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

describe("insert_dimension request", () => {
  it.each([
    [base, { range: { sheetId: 0, dimension: "ROWS", startIndex: 5, endIndex: 8 } }],
    [{ ...base, inheritFromBefore: true }, { range: { sheetId: 0, dimension: "ROWS", startIndex: 5, endIndex: 8 }, inheritFromBefore: true }],
    [{ ...base, dimension: "COLUMNS" as const, sheetId: 7, startIndex: 0, endIndex: 1, inheritFromBefore: false },
      { range: { sheetId: 7, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, inheritFromBefore: false }],
  ])("%j", (input, insert) => {
    expect(insertDimensionRequest(input)).toEqual({
      method: "POST",
      host: "sheets.googleapis.com",
      path: `/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`,
      body: { requests: [{ insertDimension: insert }] },
    });
  });

  it.each([
    [base, "Inserted 3 empty rows (now sheet ID 0, rows 6–8); existing cells from there on moved down. No cell values were written."],
    [{ ...base, dimension: "COLUMNS" as const, startIndex: 2, endIndex: 3 }, "Inserted 1 empty column (now sheet ID 0, column C); existing cells from there on moved right. No cell values were written."],
  ])("status for %j", (input, status) => {
    expect(insertDimensionStatus(input)).toBe(status);
  });
});

describe("insert_dimension tool", () => {
  it("sends one batchUpdate and returns Google's answer with the status", async () => {
    const { fetch, calls } = fakeGoogle(() => json(BATCH_UPDATE_RESPONSE));
    const result = await insertDimension.call(base, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([`POST /v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`]);
    expect(result.structuredContent).toEqual({ content: { ...BATCH_UPDATE_RESPONSE, status: insertDimensionStatus(base) } });
  });

  it("never retries and warns the insert may have happened", async () => {
    const { fetch, calls } = fakeGoogle(() => json({ error: { code: 500 } }, 500));
    const result = await insertDimension.call(base, createGoogleHttp({ accessToken: "t", fetch, retryDelayMs: 0 }));
    expect(calls).toHaveLength(1);
    expect(text(result)).toMatch(/may or may not have been made/);
  });

  it.each([
    [{ ...base, dimension: "DIMENSION_UNSPECIFIED" }, /ROWS or COLUMNS/],
    [{ ...base, dimension: "CELLS" }, /dimension/],
    [{ ...base, endIndex: 5 }, /greater than startIndex/],
    [{ ...base, startIndex: -1 }, /startIndex/],
    [{ ...base, startIndex: 0, endIndex: 2, inheritFromBefore: true }, /startIndex is greater than 0/],
    [{ ...base, sheetId: 1.5 }, /sheetId/],
    [{ ...base, endIndex: 2 ** 31 }, /endIndex/],
  ])("refuses %j without sending", async (args, message) => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const result = await insertDimension.call(args, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(message);
    expect(calls).toHaveLength(0);
  });
});
