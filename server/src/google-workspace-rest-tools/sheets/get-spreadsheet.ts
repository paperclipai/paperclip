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

export const MAX_FIELD_MASK_LENGTH = 1_000;
const FIELD_MASK_HINT = "must be a field mask such as sheets.properties.title or sheets.properties(sheetId,title), using only letters, digits, _ . , ( ) / and *";

export function isBalancedFieldMask(mask: string): boolean {
  let depth = 0;
  for (const character of mask) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

const fieldPath = z.string()
  .regex(new RegExp(`^[A-Za-z0-9_.,()*/]{1,${MAX_FIELD_MASK_LENGTH}}$`), FIELD_MASK_HINT)
  .refine(isBalancedFieldMask, FIELD_MASK_HINT);

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
  sheets?: Array<{ data?: RestGridData[]; [key: string]: unknown }>;
  [key: string]: unknown;
}

const NARROW = "Pass fewer or narrower ranges (for example one sheet, or Sheet1!A1:Z1000), leave includeGridData off, or ask for fewer fields; read the rest in further calls.";

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
          description: "Optional. Field masks naming the parts of the Spreadsheet resource to return, as paths in its JSON, for example sheets.properties.sheetId and sheets.properties.title, or grouped as sheets.properties(sheetId,title). Default: everything except cell data.",
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
