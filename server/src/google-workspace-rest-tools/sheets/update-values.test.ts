import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { SPREADSHEET_ID, UPDATE_VALUES_RESPONSE } from "./fixtures/sheets-rest.js";
import { MAX_CELLS_PER_CALL, valuesWriteStatus } from "./spreadsheet.js";
import { updateFormulas } from "./update-formulas.js";
import { updateValues } from "./update-values.js";
import { valuesUpdateRequest } from "./values-write.js";

const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

describe("values.update request", () => {
  it.each([
    ["RAW", [["Item", 12.5, true, null, ""]]],
    ["USER_ENTERED", [["=SUM(A1:A3)"], ["=VLOOKUP(B2,Prices!A:B,2,FALSE)"]]],
  ] as const)("writes with valueInputOption %s, rows first", (option, values) => {
    expect(valuesUpdateRequest(SPREADSHEET_ID, "'Q1 Plan'!A1", values.map((row) => [...row]), option)).toEqual({
      method: "PUT",
      host: "sheets.googleapis.com",
      path: `/v4/spreadsheets/${SPREADSHEET_ID}/values/'Q1%20Plan'!A1`,
      query: { valueInputOption: option },
      body: { range: "'Q1 Plan'!A1", majorDimension: "ROWS", values },
    });
  });

  it("refuses more cells than the limit before sending", () => {
    const values = Array.from({ length: 1_001 }, () => Array.from({ length: 50 }, () => 1));
    expect(() => valuesUpdateRequest(SPREADSHEET_ID, "Sheet1!A1", values, "RAW")).toThrow(/50,050 cells; the limit is 50,000 per call\. Split it .* Nothing was written\./);
    expect(() => valuesUpdateRequest(SPREADSHEET_ID, "Sheet1!A1", [Array.from({ length: MAX_CELLS_PER_CALL }, () => 1)], "RAW")).not.toThrow();
  });

  it("refuses a request body over the size limit", () => {
    expect(() => valuesUpdateRequest(SPREADSHEET_ID, "Sheet1!A1", Array.from({ length: 30 }, () => ["x".repeat(40_000)]), "RAW")).toThrow(/characters; the limit is 1,000,000/);
  });
});

describe("values write status", () => {
  it.each([
    [UPDATE_VALUES_RESPONSE, "as raw values", "Updated 4 cells in 'Q1 Plan'!A1:B2 (2 rows × 2 columns) as raw values."],
    [{ updatedRange: "Sheet1!C1", updatedRows: 1, updatedColumns: 1, updatedCells: 1 }, "as if typed into Google Sheets", "Updated 1 cell in Sheet1!C1 (1 row × 1 column) as if typed into Google Sheets."],
    [{ spreadsheetId: SPREADSHEET_ID }, "as raw values", "No cells changed in Sheet1!A1:B2."],
  ])("%j", (response, how, status) => {
    expect(valuesWriteStatus(response, "Sheet1!A1:B2", how)).toBe(status);
  });
});

describe("update_values and update_formulas tools", () => {
  it.each([
    [updateValues, "values", "RAW", "as raw values"],
    [updateFormulas, "formulas", "USER_ENTERED", "as if typed into Google Sheets"],
  ] as const)("%s writes once and reports what changed", async (tool, field, option, how) => {
    const { fetch, calls } = fakeGoogle(() => json(UPDATE_VALUES_RESPONSE));
    const result = await tool.call({ spreadsheetId: SPREADSHEET_ID, range: "'Q1 Plan'!A1:B2", [field]: [["=1+1", 2], [null, ""]] }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("valueInputOption")).toBe(option);
    expect(calls[0]!.body).toEqual({ range: "'Q1 Plan'!A1:B2", majorDimension: "ROWS", values: [["=1+1", 2], [null, ""]] });
    expect(result.structuredContent).toEqual({ content: { ...UPDATE_VALUES_RESPONSE, status: `Updated 4 cells in 'Q1 Plan'!A1:B2 (2 rows × 2 columns) ${how}.` } });
  });

  it.each([updateValues, updateFormulas])("$definition.name never retries a failed write and warns it may have happened", async (tool) => {
    const { fetch, calls } = fakeGoogle(() => json({ error: { code: 503 } }, 503));
    const field = tool === updateValues ? "values" : "formulas";
    const result = await tool.call({ spreadsheetId: SPREADSHEET_ID, range: "Sheet1!A1", [field]: [[1]] }, createGoogleHttp({ accessToken: "t", fetch, retryDelayMs: 0 }));
    expect(calls).toHaveLength(1);
    expect(text(result)).toMatch(/may or may not have been made/);
  });

  it.each([
    [{ range: "Sheet1!A1", values: [] }, /at least one row/],
    [{ range: "Sheet1!A1", values: [[{ a: 1 }]] }, /values/],
    [{ range: "Sheet1!A1", values: [[[1]]] }, /values/],
    [{ range: "Sheet1!A1", values: [[Number.NaN]] }, /values/],
    [{ range: "Sheet1!A1", values: ["a"] }, /values/],
    [{ range: "My Sheet!A1", values: [["a"]] }, /must be quoted/],
  ])("update_values refuses %j without sending", async (args, message) => {
    const { fetch, calls } = fakeGoogle(() => json({}));
    const result = await updateValues.call({ spreadsheetId: SPREADSHEET_ID, ...args }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(message);
    expect(calls).toHaveLength(0);
  });

  it("states the value input option in each description", () => {
    expect(updateValues.definition.description).toMatch(/valueInputOption RAW/);
    expect(updateFormulas.definition.description).toMatch(/valueInputOption USER_ENTERED/);
  });
});
