import { describe, expect, it } from "vitest";
import { fakeGoogle, json } from "../fixtures/fake-google.js";
import { createGoogleHttp } from "../google-http.js";
import { EMPTY_VALUES, FORMATTED_VALUES, SPREADSHEET_ID } from "./fixtures/sheets-rest.js";
import { getValues, getValuesRequest, getValuesResult } from "./get-values.js";
import { FALLBACK_MAX_RESULT_BYTES, serializedResultBytes } from "../tool.js";
import { boundedReadResult, MAX_CELLS_PER_CALL } from "./spreadsheet.js";

const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

describe("get_values request", () => {
  it.each([
    ["Sheet1!A1:B2", `/v4/spreadsheets/${SPREADSHEET_ID}/values/Sheet1!A1%3AB2`],
    ["'Q1 Plan'!A1:D4", `/v4/spreadsheets/${SPREADSHEET_ID}/values/'Q1%20Plan'!A1%3AD4`],
    ["'Bob''s list'!A:A", `/v4/spreadsheets/${SPREADSHEET_ID}/values/'Bob''s%20list'!A%3AA`],
    ["Sheet1!R1C1:R2C2", `/v4/spreadsheets/${SPREADSHEET_ID}/values/Sheet1!R1C1%3AR2C2`],
  ])("reads %s as formatted values, rows first", async (range, pathname) => {
    const request = getValuesRequest({ spreadsheetId: SPREADSHEET_ID, range });
    expect(request).toMatchObject({ method: "GET", host: "sheets.googleapis.com", query: { majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" } });
    const { fetch, calls } = fakeGoogle(() => json(EMPTY_VALUES));
    await getValues.call({ spreadsheetId: SPREADSHEET_ID, range }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(calls[0]!.url.pathname).toBe(pathname);
    expect(calls[0]!.url.searchParams.get("valueRenderOption")).toBe("FORMATTED_VALUE");
    expect(decodeURIComponent(calls[0]!.url.pathname.split("/values/")[1]!)).toBe(range);
  });
});

describe("get_values result", () => {
  it("returns Google's range and formatted values unchanged, keeping ragged rows, merged blanks and error text", () => {
    expect(getValuesResult(FORMATTED_VALUES).structuredContent).toEqual({ range: FORMATTED_VALUES.range, values: FORMATTED_VALUES.values });
  });

  it("leaves values out for an empty range, as Google does", () => {
    expect(getValuesResult(EMPTY_VALUES).structuredContent).toEqual({ range: "Sheet1!A1:Z100" });
  });

  const callWith = (values: unknown[][]) => getValues.call({ spreadsheetId: SPREADSHEET_ID, range: "Sheet1!A1:Z" },
    createGoogleHttp({ accessToken: "t", fetch: fakeGoogle(() => json({ range: "Sheet1!A1:Z", values })).fetch }));

  it.each([
    ["too many cells", [Array.from({ length: MAX_CELLS_PER_CALL + 1 }, () => "")], /50,001 cells; the limit is 50,000/],
    ["too many bytes", [["x".repeat(130_000)]], /bytes, more than the 250,000 bytes this tool can return, so it was not returned\. Ask for a narrower range/],
  ])("refuses %s instead of cutting the result", async (_name, values, message) => {
    const result = await callWith(values);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(message);
  });

  it.each([["x"], ["é"], ["\""]])("bounds the whole serialized result, text and structured content together, for cells of %j", async (unit) => {
    const sized = (count: number) => ({ range: "Sheet1!A1:Z", values: [[unit.repeat(count)], ["tail"]] });
    const bytes = (count: number) => serializedResultBytes({ content: [{ type: "text", text: JSON.stringify(sized(count)) }], structuredContent: sized(count) });
    let largest = 0;
    for (let step = 1 << 20; step >= 1; step >>= 1) if (bytes(largest + step) <= FALLBACK_MAX_RESULT_BYTES) largest += step;
    const near = await callWith(sized(largest).values);
    expect(near.isError).toBeUndefined();
    expect(serializedResultBytes(near)).toBe(bytes(largest));
    expect(serializedResultBytes(near)).toBeGreaterThan(FALLBACK_MAX_RESULT_BYTES - 16);
    expect(bytes(largest + 1)).toBeGreaterThan(FALLBACK_MAX_RESULT_BYTES);
    expect(text(await callWith(sized(largest + 1).values))).toMatch(/bytes, more than the 250,000 bytes this tool can return, so it was not returned\. Ask for a narrower range/);
  });

  it("accepts exactly the cell limit and refuses one more", () => {
    expect(boundedReadResult({ range: "Sheet1!A1" }, MAX_CELLS_PER_CALL, "narrow").isError).toBeUndefined();
    expect(() => boundedReadResult({ range: "Sheet1!A1" }, MAX_CELLS_PER_CALL + 1, "narrow")).toThrow(/50,001 cells/);
  });
});

describe("get_values tool", () => {
  it("returns a narrowing error when the result is too large", async () => {
    const values = Array.from({ length: 1_001 }, () => Array.from({ length: 50 }, () => "1"));
    const { fetch } = fakeGoogle(() => json({ range: "Sheet1!A1:AX1001", values }));
    const result = await getValues.call({ spreadsheetId: SPREADSHEET_ID, range: "Sheet1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Ask for a narrower range/);
  });

  it("turns Google's too-large response into the same narrowing error", async () => {
    const { fetch } = fakeGoogle(() => new Response("{}", { status: 200, headers: { "content-length": String(21 * 1024 * 1024) } }));
    const result = await getValues.call({ spreadsheetId: SPREADSHEET_ID, range: "Sheet1" }, createGoogleHttp({ accessToken: "t", fetch }));
    expect(text(result)).toMatch(/too large to return\. Ask for a narrower range/);
  });

  it.each([
    [{ spreadsheetId: SPREADSHEET_ID, range: "Q1 Plan!A1" }, /must be quoted/],
    [{ spreadsheetId: "../other", range: "A1" }, /spreadsheet ID/],
    [{ spreadsheetId: SPREADSHEET_ID }, /range/],
    [{ spreadsheetId: SPREADSHEET_ID, range: "Sheet1!A1", valueRenderOption: "FORMULA" }, null],
  ])("validates %j before sending", async (args, message) => {
    const { fetch, calls } = fakeGoogle(() => json(EMPTY_VALUES));
    const result = await getValues.call(args, createGoogleHttp({ accessToken: "t", fetch }));
    if (message) {
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(message);
      expect(calls).toHaveLength(0);
    } else {
      expect(calls[0]!.url.searchParams.get("valueRenderOption")).toBe("FORMATTED_VALUE");
    }
  });
});
