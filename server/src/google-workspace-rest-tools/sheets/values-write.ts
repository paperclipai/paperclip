import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { GoogleHttp, GoogleRequest } from "../google-http.js";
import { structuredResult } from "../tool.js";
import {
  assertWriteWithinBounds,
  type cellValue,
  countCells,
  SHEETS_HOST,
  type UpdateValuesResponse,
  valuesPath,
  valuesWriteStatus,
} from "./spreadsheet.js";

export type ValueInputOption = "RAW" | "USER_ENTERED";
export type CellValue = z.infer<typeof cellValue>;

export const HOW_WRITTEN: Record<ValueInputOption, string> = {
  RAW: "as raw values",
  USER_ENTERED: "as if typed into Google Sheets",
};

export function valuesUpdateRequest(id: string, range: string, values: CellValue[][], option: ValueInputOption): GoogleRequest {
  const body = { range, majorDimension: "ROWS", values };
  assertWriteWithinBounds(countCells(values), body);
  return {
    method: "PUT",
    host: SHEETS_HOST,
    path: valuesPath(id, range),
    query: { valueInputOption: option },
    body,
  };
}

export function valuesUpdateResult(response: UpdateValuesResponse, range: string, option: ValueInputOption): CallToolResult {
  return structuredResult({ content: { ...response, status: valuesWriteStatus(response, range, HOW_WRITTEN[option]) } });
}

export async function runValuesUpdate(http: GoogleHttp, id: string, range: string, values: CellValue[][], option: ValueInputOption): Promise<CallToolResult> {
  const response = await http.send<UpdateValuesResponse>(valuesUpdateRequest(id, range, values, option));
  return valuesUpdateResult(response, range, option);
}
