import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GoogleRequest } from "../google-http.js";
import { compact, defineTool } from "../tool.js";
import {
  boundedReadResult,
  countCells,
  RANGE_RULES,
  sendRead,
  SHEETS_HOST,
  sheetRange,
  spreadsheetId,
  spreadsheetIdInput,
  valuesPath,
} from "./spreadsheet.js";

const args = z.object({ spreadsheetId, range: sheetRange });
export type GetValuesArgs = z.infer<typeof args>;

export interface RestValueRange {
  range?: string;
  majorDimension?: string;
  values?: unknown[][];
}

const NARROW = "Ask for a narrower range, with fewer rows or columns (for example Sheet1!A1:Z1000), and read the rest in further calls.";

export function getValuesRequest(input: GetValuesArgs): GoogleRequest {
  return {
    method: "GET",
    host: SHEETS_HOST,
    path: valuesPath(input.spreadsheetId, input.range),
    query: { majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" },
  };
}

export function getValuesResult(response: RestValueRange): CallToolResult {
  const value = compact({ range: response.range, values: response.values });
  return boundedReadResult(value, countCells(response.values), NARROW);
}

export const getValues = defineTool({
  definition: {
    name: "get_values",
    description: "Returns the values in one range of a spreadsheet, row by row, exactly as Google Sheets displays them (formatted values): numbers, currency, percentages, dates and booleans come back as the formatted text shown in the cell (for example \"$1,200.50\", \"12%\", \"1/5/2026\", \"TRUE\"), and formula cells return their result, not the formula. Empty rows and columns at the end of the range are left out, so rows can have different lengths and an empty range has no values. In a merged area only the top-left cell holds the value. Reads at most 50,000 cells per call; a larger result is an error asking for a smaller range, never a cut-off result. For several ranges at once, formulas, or unformatted numbers and date serial numbers, use get_spreadsheet with ranges and includeGridData.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: spreadsheetIdInput,
        range: { type: "string", description: `Required. The range to read, in ${RANGE_RULES}` },
      },
      required: ["spreadsheetId", "range"],
    },
    outputSchema: {
      type: "object",
      properties: {
        range: { type: "string", description: "The range the values cover, in A1 notation." },
        values: {
          type: "array",
          description: "The values, one array per row. Empty trailing rows and columns are omitted.",
          items: { type: "array", items: {} },
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  args,
  async run(input, http) {
    return getValuesResult(await sendRead<RestValueRange>(http, getValuesRequest(input), NARROW));
  },
});
