import { google } from "googleapis";
import type { GoogleSheetsServiceAccount } from "./config.js";

export interface SpreadsheetSummary {
  spreadsheetId: string;
  title: string | null;
  spreadsheetUrl: string | null;
}

export interface SheetTabSummary {
  sheetId: number;
  title: string;
  index: number | null;
  rowCount: number | null;
  columnCount: number | null;
}

export interface SpreadsheetInfo extends SpreadsheetSummary {
  sheets: SheetTabSummary[];
}

export interface ValuesResult {
  spreadsheetId: string;
  range: string;
  values: unknown[][];
}

export interface SearchRowsResult {
  spreadsheetId: string;
  range: string;
  query: string;
  matches: Array<{
    rowIndex: number;
    values: unknown[];
  }>;
}

export interface WriteResult {
  spreadsheetId: string;
  range: string;
  updatedRange?: string | null;
  updatedRows?: number | null;
  updatedCells?: number | null;
}

export interface GoogleSheetsClient {
  listSpreadsheets(spreadsheetIds: string[]): Promise<SpreadsheetSummary[]>;
  getSpreadsheetInfo(spreadsheetId: string): Promise<SpreadsheetInfo>;
  readValues(spreadsheetId: string, range: string): Promise<ValuesResult>;
  searchRows(input: {
    spreadsheetId: string;
    range: string;
    query: string;
    caseSensitive?: boolean;
    maxResults?: number;
  }): Promise<SearchRowsResult>;
  appendRows(input: {
    spreadsheetId: string;
    range: string;
    values: unknown[][];
    valueInputOption: "RAW" | "USER_ENTERED";
  }): Promise<WriteResult>;
  updateValues(input: {
    spreadsheetId: string;
    range: string;
    values: unknown[][];
    valueInputOption: "RAW" | "USER_ENTERED";
  }): Promise<WriteResult>;
  addSheetTab(input: {
    spreadsheetId: string;
    title: string;
    rowCount?: number;
    columnCount?: number;
  }): Promise<{ spreadsheetId: string; sheet: SheetTabSummary }>;
  clearValues(spreadsheetId: string, range: string): Promise<WriteResult>;
  deleteRows(input: {
    spreadsheetId: string;
    sheetId: number;
    startIndex: number;
    endIndex: number;
  }): Promise<{ spreadsheetId: string; sheetId: number; deletedRows: number }>;
}

type SheetsApi = ReturnType<typeof google.sheets>;

function normalizeRows(values: unknown): unknown[][] {
  return Array.isArray(values)
    ? values.map((row) => Array.isArray(row) ? row : [row])
    : [];
}

function summarizeSpreadsheet(data: Record<string, unknown>, spreadsheetId: string): SpreadsheetSummary {
  const properties = data.properties as Record<string, unknown> | undefined;
  return {
    spreadsheetId: typeof data.spreadsheetId === "string" ? data.spreadsheetId : spreadsheetId,
    title: typeof properties?.title === "string" ? properties.title : null,
    spreadsheetUrl: typeof data.spreadsheetUrl === "string" ? data.spreadsheetUrl : null,
  };
}

function summarizeSheet(raw: unknown): SheetTabSummary {
  const sheet = raw as Record<string, unknown>;
  const properties = sheet.properties as Record<string, unknown> | undefined;
  const gridProperties = properties?.gridProperties as Record<string, unknown> | undefined;
  return {
    sheetId: Number(properties?.sheetId),
    title: typeof properties?.title === "string" ? properties.title : "Untitled",
    index: typeof properties?.index === "number" ? properties.index : null,
    rowCount: typeof gridProperties?.rowCount === "number" ? gridProperties.rowCount : null,
    columnCount: typeof gridProperties?.columnCount === "number" ? gridProperties.columnCount : null,
  };
}

export function createGoogleSheetsClient(serviceAccount: GoogleSheetsServiceAccount): GoogleSheetsClient {
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets: SheetsApi = google.sheets({ version: "v4", auth });

  async function getSpreadsheet(spreadsheetId: string, fields?: string) {
    const response = await sheets.spreadsheets.get({ spreadsheetId, fields });
    return response.data as Record<string, unknown>;
  }

  return {
    async listSpreadsheets(spreadsheetIds) {
      return Promise.all(
        spreadsheetIds.map(async (spreadsheetId) =>
          summarizeSpreadsheet(
            await getSpreadsheet(spreadsheetId, "spreadsheetId,spreadsheetUrl,properties.title"),
            spreadsheetId,
          )
        ),
      );
    },

    async getSpreadsheetInfo(spreadsheetId) {
      const data = await getSpreadsheet(
        spreadsheetId,
        "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title,index,gridProperties(rowCount,columnCount))",
      );
      return {
        ...summarizeSpreadsheet(data, spreadsheetId),
        sheets: Array.isArray(data.sheets) ? data.sheets.map(summarizeSheet) : [],
      };
    },

    async readValues(spreadsheetId, range) {
      const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
      return {
        spreadsheetId,
        range: String(response.data.range ?? range),
        values: normalizeRows(response.data.values),
      };
    },

    async searchRows({ spreadsheetId, range, query, caseSensitive = false, maxResults = 50 }) {
      const values = await this.readValues(spreadsheetId, range);
      const needle = caseSensitive ? query : query.toLowerCase();
      const matches = values.values.flatMap((row, rowIndex) => {
        const haystack = row.map((cell) => String(cell ?? "")).join("\t");
        const comparable = caseSensitive ? haystack : haystack.toLowerCase();
        return comparable.includes(needle) ? [{ rowIndex: rowIndex + 1, values: row }] : [];
      });
      return {
        spreadsheetId,
        range: values.range,
        query,
        matches: matches.slice(0, maxResults),
      };
    },

    async appendRows({ spreadsheetId, range, values, valueInputOption }) {
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption,
        requestBody: { values },
      });
      return {
        spreadsheetId,
        range,
        updatedRange: response.data.updates?.updatedRange ?? null,
        updatedRows: response.data.updates?.updatedRows ?? null,
        updatedCells: response.data.updates?.updatedCells ?? null,
      };
    },

    async updateValues({ spreadsheetId, range, values, valueInputOption }) {
      const response = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption,
        requestBody: { values },
      });
      return {
        spreadsheetId,
        range,
        updatedRange: response.data.updatedRange ?? null,
        updatedRows: response.data.updatedRows ?? null,
        updatedCells: response.data.updatedCells ?? null,
      };
    },

    async addSheetTab({ spreadsheetId, title, rowCount, columnCount }) {
      const response = await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title,
                gridProperties: {
                  ...(rowCount === undefined ? {} : { rowCount }),
                  ...(columnCount === undefined ? {} : { columnCount }),
                },
              },
            },
          }],
        },
      });
      const addedSheet = response.data.replies?.[0]?.addSheet;
      return {
        spreadsheetId,
        sheet: summarizeSheet(addedSheet ?? { properties: { title } }),
      };
    },

    async clearValues(spreadsheetId, range) {
      const response = await sheets.spreadsheets.values.clear({
        spreadsheetId,
        range,
        requestBody: {},
      });
      return {
        spreadsheetId,
        range,
        updatedRange: response.data.clearedRange ?? null,
      };
    },

    async deleteRows({ spreadsheetId, sheetId, startIndex, endIndex }) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex,
                endIndex,
              },
            },
          }],
        },
      });
      return {
        spreadsheetId,
        sheetId,
        deletedRows: endIndex - startIndex,
      };
    },
  };
}
