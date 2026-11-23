import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GoogleRequest } from "../google-http.js";
import { defineTool, structuredResult } from "../tool.js";
import { describeDimensionRange } from "./range.js";
import { batchUpdatePath, SHEETS_HOST, spreadsheetId, spreadsheetIdInput, writeOutputSchema } from "./spreadsheet.js";

const INT32_MAX = 2_147_483_647;
export const DIMENSIONS = ["DIMENSION_UNSPECIFIED", "COLUMNS", "ROWS"] as const;
const index = z.number().int().min(0).max(INT32_MAX);

const args = z.object({
  spreadsheetId,
  sheetId: index,
  dimension: z.enum(DIMENSIONS).refine((value) => value !== "DIMENSION_UNSPECIFIED", "must be ROWS or COLUMNS"),
  startIndex: index,
  endIndex: index,
  inheritFromBefore: z.boolean().optional(),
}).superRefine((input, context) => {
  if (input.endIndex <= input.startIndex) context.addIssue({ code: "custom", path: ["endIndex"], message: "must be greater than startIndex" });
  if (input.inheritFromBefore && input.startIndex === 0) {
    context.addIssue({ code: "custom", path: ["inheritFromBefore"], message: "can be true only when startIndex is greater than 0" });
  }
});
export type InsertDimensionArgs = z.infer<typeof args>;

export interface BatchUpdateResponse {
  spreadsheetId?: string;
  replies?: unknown[];
  [key: string]: unknown;
}

export function insertDimensionRequest(input: InsertDimensionArgs): GoogleRequest {
  return {
    method: "POST",
    host: SHEETS_HOST,
    path: batchUpdatePath(input.spreadsheetId),
    body: {
      requests: [{
        insertDimension: {
          range: { sheetId: input.sheetId, dimension: input.dimension, startIndex: input.startIndex, endIndex: input.endIndex },
          ...(input.inheritFromBefore === undefined ? {} : { inheritFromBefore: input.inheritFromBefore }),
        },
      }],
    },
  };
}

export function insertDimensionStatus(input: InsertDimensionArgs): string {
  const count = input.endIndex - input.startIndex;
  const noun = input.dimension === "COLUMNS" ? (count === 1 ? "column" : "columns") : (count === 1 ? "row" : "rows");
  const range = { sheetId: input.sheetId, dimension: input.dimension, startIndex: input.startIndex, endIndex: input.endIndex };
  return `Inserted ${count} empty ${noun} (now ${describeDimensionRange(range)}); existing cells from there on moved ${input.dimension === "COLUMNS" ? "right" : "down"}. No cell values were written.`;
}

export function insertDimensionResult(input: InsertDimensionArgs, response: BatchUpdateResponse): CallToolResult {
  return structuredResult({ content: { ...response, status: insertDimensionStatus(input) } });
}

export const insertDimension = defineTool({
  definition: {
    name: "insert_dimension",
    title: "Insert rows or columns",
    description: "Inserts empty rows or columns into one sheet at a 0-based position, moving the existing rows down or columns right. It writes no cell values and deletes nothing. The result's status says which rows or columns were inserted. A failed insert is never retried automatically.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: spreadsheetIdInput,
        sheetId: { type: "integer", description: "Required. The ID of the sheet to insert into (sheets.properties.sheetId from get_spreadsheet; the first sheet is often 0)." },
        dimension: { type: "string", enum: [...DIMENSIONS], description: "Required. ROWS or COLUMNS. DIMENSION_UNSPECIFIED is refused." },
        startIndex: { type: "integer", description: "Required. The 0-based start index of the insertion (inclusive). Row 1 is index 0; column A is index 0." },
        endIndex: { type: "integer", description: "Required. The 0-based end index of the insertion (exclusive). endIndex minus startIndex rows or columns are inserted." },
        inheritFromBefore: { type: "boolean", description: "Optional. True to copy formatting and size from the row or column before the insertion (startIndex must then be greater than 0); false to copy from the one after. Default: false." },
      },
      required: ["spreadsheetId", "sheetId", "dimension", "startIndex", "endIndex"],
    },
    outputSchema: writeOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  args,
  async run(input, http) {
    return insertDimensionResult(input, await http.send<BatchUpdateResponse>(insertDimensionRequest(input)));
  },
});
