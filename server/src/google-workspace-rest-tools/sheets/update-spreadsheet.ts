import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import type { GoogleRequest } from "../google-http.js";
import { defineTool, structuredResult } from "../tool.js";
import type { BatchUpdateResponse } from "./insert-dimension.js";
import { describeDimensionRange, describeGridRange, type DimensionRange, type GridRange } from "./range.js";
import { assertWriteWithinBounds, batchUpdatePath, SHEETS_HOST, spreadsheetId, spreadsheetIdInput, writeOutputSchema } from "./spreadsheet.js";

export const MAX_REQUESTS = 500;

export const SUPPORTED_REQUESTS = [
  "updateSpreadsheetProperties", "updateSheetProperties", "updateDimensionProperties", "updateNamedRange", "repeatCell",
  "addNamedRange", "deleteNamedRange", "addSheet", "deleteSheet", "autoFill", "cutPaste", "copyPaste", "mergeCells",
  "unmergeCells", "updateBorders", "updateCells", "addFilterView", "appendCells", "clearBasicFilter", "deleteDimension",
  "deleteEmbeddedObject", "deleteFilterView", "duplicateFilterView", "duplicateSheet", "findReplace", "insertDimension",
  "insertRange", "moveDimension", "updateEmbeddedObjectPosition", "pasteData", "textToColumns", "updateFilterView",
  "deleteRange", "appendDimension", "addConditionalFormatRule", "updateConditionalFormatRule", "deleteConditionalFormatRule",
  "sortRange", "setDataValidation", "setBasicFilter", "addProtectedRange", "updateProtectedRange", "deleteProtectedRange",
  "autoResizeDimensions", "addChart", "updateChartSpec", "updateBanding", "addBanding", "deleteBanding",
  "createDeveloperMetadata", "updateDeveloperMetadata", "deleteDeveloperMetadata", "randomizeRange", "addDimensionGroup",
  "deleteDimensionGroup", "updateDimensionGroup", "trimWhitespace", "deleteDuplicates", "updateEmbeddedObjectBorder",
  "addSlicer", "updateSlicerSpec", "addTable", "updateTable", "deleteTable",
] as const;

export const COMMENT_REQUESTS = ["insertComment", "addCommentReply", "updateCommentPost", "deleteComment", "deleteCommentReply"] as const;
export const DATA_SOURCE_REQUESTS = ["addDataSource", "updateDataSource", "deleteDataSource", "refreshDataSource", "cancelDataSourceRefresh"] as const;

export const REMOVING_REQUESTS = new Set([
  "deleteSheet", "deleteDimension", "deleteRange", "deleteNamedRange", "deleteEmbeddedObject", "deleteFilterView",
  "deleteConditionalFormatRule", "deleteProtectedRange", "deleteBanding", "deleteDeveloperMetadata", "deleteDimensionGroup",
  "deleteDuplicates", "deleteTable", "clearBasicFilter",
]);

const supported = new Set<string>(SUPPORTED_REQUESTS);
const comments = new Set<string>(COMMENT_REQUESTS);
const dataSources = new Set<string>(DATA_SOURCE_REQUESTS);

const args = z.object({
  spreadsheetId,
  requests: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_REQUESTS),
  writeControl: z.object({ requiredRevisionId: z.string().optional() }).optional(),
});
export type UpdateSpreadsheetArgs = z.infer<typeof args>;

type SheetsRequest = Record<string, unknown>;

export function requestKind(request: SheetsRequest, position: number): string {
  const keys = Object.keys(request);
  const label = `Request ${position + 1}`;
  if (keys.length !== 1) throw new GoogleToolError("invalid_argument", `${label} must have exactly one operation, such as updateCells or addSheet; it has ${keys.length}. Nothing was changed.`);
  const kind = keys[0]!;
  const body = request[kind];
  if (comments.has(kind)) throw new GoogleToolError("unsupported", `${label}: ${kind} is not available here; comments cannot be changed through this tool. Nothing was changed.`);
  if (dataSources.has(kind)) throw new GoogleToolError("unsupported", `${label}: ${kind} is not available here; data sources need BigQuery access that this connection does not have. Nothing was changed.`);
  if (!supported.has(kind)) throw new GoogleToolError("invalid_argument", `${label}: ${kind} is not a supported operation. Nothing was changed.`);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new GoogleToolError("invalid_argument", `${label}: ${kind} must be an object. Nothing was changed.`);
  return kind;
}

interface RowData { values?: unknown[] }

export function writtenCells(kind: string, body: Record<string, unknown>): number {
  if (kind !== "updateCells" && kind !== "appendCells") return 0;
  const rows = Array.isArray(body.rows) ? (body.rows as RowData[]) : [];
  return rows.reduce((total, row) => total + (Array.isArray(row?.values) ? row.values.length : 0), 0);
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function describeArea(value: Record<string, unknown>): string {
  if ("dimension" in value) return describeDimensionRange(value as DimensionRange);
  if ("rowIndex" in value || "columnIndex" in value) {
    const coordinate = value as { sheetId?: number; rowIndex?: number; columnIndex?: number };
    return describeGridRange({ sheetId: coordinate.sheetId, startRowIndex: coordinate.rowIndex ?? 0, startColumnIndex: coordinate.columnIndex ?? 0 });
  }
  return describeGridRange(value as GridRange);
}

function target(body: Record<string, unknown>): string | undefined {
  if (isObject(body.source) && isObject(body.destination)) return `${describeArea(body.source)} to ${describeArea(body.destination)}`;
  if (isObject(body.source) && typeof body.destinationIndex === "number") return `${describeArea(body.source)} to 0-based index ${body.destinationIndex}`;
  for (const key of ["range", "source", "dimensions", "start", "coordinate"]) {
    const value = body[key];
    if (isObject(value)) return describeArea(value);
  }
  if (typeof body.sheetId === "number") return `sheet ID ${body.sheetId}`;
  if (typeof body.sourceSheetId === "number") return `sheet ID ${body.sourceSheetId}`;
  const properties = body.properties;
  if (isObject(properties) && typeof properties.sheetId === "number") return `sheet ID ${properties.sheetId}`;
  return undefined;
}

export function describeRequest(request: SheetsRequest, position: number): string {
  const kind = Object.keys(request)[0]!;
  const body = request[kind] as Record<string, unknown>;
  const where = target(body);
  const cells = writtenCells(kind, body);
  const written = cells > 0 ? ` (${cells.toLocaleString("en-US")} ${cells === 1 ? "cell" : "cells"} written)` : "";
  return `${position + 1}. ${kind}${where ? ` on ${where}` : ""}${written}`;
}

export function updateSpreadsheetRequest(input: UpdateSpreadsheetArgs): GoogleRequest {
  if (input.writeControl !== undefined) {
    throw new GoogleToolError("unsupported", "writeControl is not available here: the Sheets API cannot make this change conditional on a revision. Call again without writeControl. Nothing was changed.");
  }
  let cells = 0;
  input.requests.forEach((request, position) => {
    const kind = requestKind(request, position);
    cells += writtenCells(kind, request[kind] as Record<string, unknown>);
  });
  const body = { requests: input.requests };
  assertWriteWithinBounds(cells, body);
  return { method: "POST", host: SHEETS_HOST, path: batchUpdatePath(input.spreadsheetId), body };
}

export function updateSpreadsheetStatus(requests: readonly SheetsRequest[]): string {
  const count = requests.length;
  return `Applied ${count} ${count === 1 ? "request" : "requests"}: ${requests.map(describeRequest).join("; ")}.`;
}

export function updateSpreadsheetResult(input: UpdateSpreadsheetArgs, response: BatchUpdateResponse): CallToolResult {
  return structuredResult({ content: { ...response, status: updateSpreadsheetStatus(input.requests) } });
}

export const updateSpreadsheet = defineTool({
  definition: {
    name: "update_spreadsheet",
    description: "Applies one or more Sheets API batchUpdate requests to a spreadsheet, in order and all together: if any request is invalid, none is applied. Each request is an object with one operation, such as updateCells, repeatCell, mergeCells, addSheet, updateSheetProperties, addChart, sortRange or findReplace. Some operations remove content: deleteSheet, deleteDimension, deleteRange, deleteDuplicates and deleteTable delete sheets, rows, columns or cells, and cutPaste, findReplace, sortRange and pasteData overwrite cells. It never deletes the spreadsheet itself, changes who it is shared with, or creates a spreadsheet. Comment and data source operations are refused, and so is writeControl. updateCells and appendCells may write at most 50,000 cells per call. The result's status lists each operation and the range it changed. A failed update is never retried automatically.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheetId: spreadsheetIdInput,
        requests: {
          type: "array",
          items: { type: "object", additionalProperties: { description: "Properties of the object." } },
          description: "Required. The updates, each a Sheets API Request object with exactly one operation (https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request). Applied in order; if any is invalid, none is applied. Ranges use 0-based sheetId, row and column indexes, with end indexes exclusive.",
        },
        writeControl: {
          type: "object",
          properties: { requiredRevisionId: { type: "string", description: "Not supported here." } },
          description: "Optional. Not supported here: any value is refused.",
        },
      },
      required: ["spreadsheetId", "requests"],
    },
    outputSchema: writeOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  args,
  async run(input, http) {
    return updateSpreadsheetResult(input, await http.send<BatchUpdateResponse>(updateSpreadsheetRequest(input)));
  },
});
