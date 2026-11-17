import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import type { GoogleRequest } from "../google-http.js";
import { defineTool } from "../tool.js";
import {
  boundedReadResult,
  contentOutputSchema,
  RANGE_RULES,
  sendRead,
  SHEETS_HOST,
  sheetRange,
  spreadsheetId,
  spreadsheetIdInput,
  spreadsheetPath,
} from "./spreadsheet.js";

export const MAX_RANGES = 100;
export const MAX_FIELDS = 100;

const fieldPath = z.string().regex(/^[A-Za-z0-9_.()*/]{1,300}$/, "must be a field path such as sheets.properties.title");

const args = z.object({
  spreadsheetId,
  includeGridData: z.boolean().optional(),
  fields: z.array(fieldPath).max(MAX_FIELDS).optional(),
  ranges: z.array(sheetRange).max(MAX_RANGES).optional(),
  commentsIncluded: z.boolean().optional(),
});
export type GetSpreadsheetArgs = z.infer<typeof args>;

interface RestGridData { rowData?: Array<{ values?: unknown[] }> }
export interface RestSpreadsheet {
  spreadsheetId?: string;
  sheets?: Array<{ data?: RestGridData[] }>;
  [key: string]: unknown;
}

const NARROW = "Pass ranges to read part of the spreadsheet, leave includeGridData off, or ask for fewer fields; read the rest in further calls.";

export function getSpreadsheetRequest(input: GetSpreadsheetArgs): GoogleRequest {
  if (input.commentsIncluded) {
    throw new GoogleToolError("unsupported", "Comments are not available from this tool. Call it again without commentsIncluded.");
  }
  return {
    method: "GET",
    host: SHEETS_HOST,
    path: spreadsheetPath(input.spreadsheetId),
    query: {
      includeGridData: input.includeGridData ?? false,
      ranges: input.ranges?.length ? input.ranges : undefined,
      fields: input.fields?.length ? input.fields.join(",") : undefined,
    },
  };
}

export function gridCellCount(spreadsheet: RestSpreadsheet): number {
  let cells = 0;
  for (const sheet of spreadsheet.sheets ?? []) {
    for (const grid of sheet.data ?? []) {
      for (const row of grid.rowData ?? []) cells += row.values?.length ?? 0;
    }
  }
  return cells;
}

export function getSpreadsheetResult(spreadsheet: RestSpreadsheet): CallToolResult {
  return boundedReadResult({ content: spreadsheet }, gridCellCount(spreadsheet), NARROW);
}

export const getSpreadsheet = defineTool({
  definition: {
    name: "get_spreadsheet",
    description: "Returns a spreadsheet as Google's Sheets API Spreadsheet resource: its title, locale, time zone, sheets (names, IDs, sizes, frozen rows), named ranges and other metadata. With includeGridData it also returns cell data for ranges (or every sheet): each cell has userEnteredValue (what was typed, including formulas), effectiveValue (the computed value; dates and times are serial numbers counted in days from December 30, 1899), formattedValue (the text shown) and its format; merged areas are listed under merges. Use fields to return only what you need. Returns at most 50,000 cells per call; a larger result is an error asking for narrower ranges or fewer fields, never a cut-off result. Comments are not available (commentsIncluded is refused).",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: spreadsheetIdInput,
        includeGridData: { type: "boolean", description: "Optional. True to return cell data. Ignored when fields is set. Default: false." },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Optional. Field masks naming the parts of the Spreadsheet resource to return, as paths in its JSON, for example sheets.properties.sheetId and sheets.properties.title. Default: everything except cell data.",
        },
        ranges: {
          type: "array",
          items: { type: "string" },
          description: `Optional. The ranges to return, each in ${RANGE_RULES} Default: the whole spreadsheet.`,
        },
        commentsIncluded: { type: "boolean", description: "Optional. Not supported here: true is refused. Default: false." },
      },
      required: ["spreadsheetId"],
    },
    outputSchema: contentOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  args,
  async run(input, http) {
    return getSpreadsheetResult(await sendRead<RestSpreadsheet>(http, getSpreadsheetRequest(input), NARROW));
  },
});
