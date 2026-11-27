import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import type { GoogleHttp, GoogleRequest } from "../google-http.js";
import { structuredResult } from "../tool.js";
import { checkSheetRange } from "./range.js";

export const SHEETS_HOST = "sheets.googleapis.com" as const;
export const SHEETS_BASE = "/v4/spreadsheets";
export const MAX_CELLS_PER_CALL = 50_000;
export const MAX_REQUEST_CHARS = 1_000_000;

const formatCount = (value: number) => value.toLocaleString("en-US");

export const spreadsheetId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/, "must be a spreadsheet ID (letters, digits, - and _), as in the spreadsheet's URL after /d/");

export const sheetRange = z.string().superRefine((value, context) => {
  const check = checkSheetRange(value);
  if (!check.ok) context.addIssue({ code: "custom", message: check.message });
});

export const cellValue = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const cellGrid = z.array(z.array(cellValue)).min(1, "must contain at least one row");

export function spreadsheetPath(id: string): string {
  return `${SHEETS_BASE}/${id}`;
}

export function batchUpdatePath(id: string): string {
  return `${SHEETS_BASE}/${id}:batchUpdate`;
}

export function valuesPath(id: string, range: string): string {
  return `${SHEETS_BASE}/${id}/values/${encodeURIComponent(range)}`;
}

export function countCells(rows: readonly (readonly unknown[] | undefined)[] | undefined): number {
  return (rows ?? []).reduce((total, row) => total + (row?.length ?? 0), 0);
}

export function assertWriteWithinBounds(cells: number, body: unknown): void {
  if (cells > MAX_CELLS_PER_CALL) {
    throw new GoogleToolError("invalid_argument", `This call would write ${formatCount(cells)} cells; the limit is ${formatCount(MAX_CELLS_PER_CALL)} per call. Split it into smaller ranges. Nothing was written.`);
  }
  const size = JSON.stringify(body).length;
  if (size > MAX_REQUEST_CHARS) {
    throw new GoogleToolError("invalid_argument", `This call would send ${formatCount(size)} characters; the limit is ${formatCount(MAX_REQUEST_CHARS)} per call. Split it into smaller writes. Nothing was written.`);
  }
}

export function boundedReadResult(value: Record<string, unknown>, cells: number, narrow: string): CallToolResult {
  if (cells > MAX_CELLS_PER_CALL) {
    throw new GoogleToolError("incomplete", `The result has ${formatCount(cells)} cells; the limit is ${formatCount(MAX_CELLS_PER_CALL)} per call. ${narrow}`);
  }
  return structuredResult(value);
}

export async function sendRead<T>(http: GoogleHttp, request: GoogleRequest, narrow: string): Promise<T> {
  try {
    return await http.send<T>(request);
  } catch (error) {
    if (error instanceof GoogleToolError && error.kind === "invalid_response" && /too large/.test(error.message)) {
      throw new GoogleToolError("incomplete", `Google's response is too large to return. ${narrow}`, error.httpStatus);
    }
    throw error;
  }
}

export const contentOutputSchema = {
  type: "object",
  properties: {
    content: { type: "object", description: "Google's Sheets API response, as JSON." },
  },
} as const;

export const writeOutputSchema = {
  type: "object",
  properties: {
    content: {
      type: "object",
      description: "Google's Sheets API response, as JSON, plus status: a sentence saying exactly what changed.",
      properties: { status: { type: "string", description: "What changed: which ranges and how many cells." } },
    },
  },
} as const;

export const spreadsheetIdInput = { type: "string", description: "Required. The ID of the spreadsheet, the part of its URL after /d/." } as const;

export const RANGE_RULES = "A1 notation (Sheet1!A1:C10, Sheet1!A:C, Sheet1!2:5) or R1C1 notation (Sheet1!R1C1:R10C3). Without a sheet name the first sheet is used. Put a sheet name with spaces or punctuation in single quotes and double any apostrophe: 'Q1 Plan'!A1:B2, 'Bob''s list'!A:A.";

export interface UpdateValuesResponse {
  spreadsheetId?: string;
  updatedRange?: string;
  updatedRows?: number;
  updatedColumns?: number;
  updatedCells?: number;
}

export function valuesWriteStatus(response: UpdateValuesResponse, requestedRange: string, how: string): string {
  const cells = response.updatedCells ?? 0;
  if (cells === 0) return `No cells changed in ${response.updatedRange ?? requestedRange}.`;
  const rows = response.updatedRows ?? 0;
  const columns = response.updatedColumns ?? 0;
  return `Updated ${formatCount(cells)} ${cells === 1 ? "cell" : "cells"} in ${response.updatedRange ?? requestedRange} (${rows} ${rows === 1 ? "row" : "rows"} × ${columns} ${columns === 1 ? "column" : "columns"}) ${how}.`;
}
