import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GoogleSheetsClient } from "./google-client.js";

export type ToolResult = CallToolResult;

export interface GoogleSheetsToolDefinition {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  annotations: ToolAnnotations;
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}

export interface GoogleSheetsToolOptions {
  client: GoogleSheetsClient;
  allowedSpreadsheetIds: string[];
  secretRedactions?: string[];
}

type ToolRisk = "read" | "write" | "destructive";

const spreadsheetIdSchema = z.string().trim().min(1);
const rangeSchema = z.string().trim().min(1).max(500).refine(
  (range) => !/[\r\n]/.test(range),
  "Range must be a single-line A1 notation range.",
);
const valuesSchema = z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])));
const valueInputOptionSchema = z.enum(["RAW", "USER_ENTERED"]).default("RAW");

const spreadsheetToolSchema = z.object({
  spreadsheetId: spreadsheetIdSchema,
});

const readValuesSchema = spreadsheetToolSchema.extend({
  range: rangeSchema,
});

const searchRowsSchema = readValuesSchema.extend({
  query: z.string().min(1),
  caseSensitive: z.boolean().optional().default(false),
  maxResults: z.number().int().positive().max(500).optional().default(50),
});

const appendRowsSchema = readValuesSchema.extend({
  values: valuesSchema.min(1),
  valueInputOption: valueInputOptionSchema,
});

const updateValuesSchema = readValuesSchema.extend({
  values: valuesSchema.min(1),
  valueInputOption: valueInputOptionSchema,
});

const addSheetTabSchema = spreadsheetToolSchema.extend({
  title: z.string().trim().min(1).max(100),
  rowCount: z.number().int().positive().max(1000000).optional(),
  columnCount: z.number().int().positive().max(18278).optional(),
});

const deleteRowsSchema = spreadsheetToolSchema.extend({
  sheetId: z.number().int().nonnegative(),
  startIndex: z.number().int().nonnegative(),
  endIndex: z.number().int().positive(),
});

function annotationsFor(title: string, risk: ToolRisk): ToolAnnotations {
  if (risk === "read") {
    return { title, readOnlyHint: true, openWorldHint: false };
  }
  if (risk === "write") {
    return { title, readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  }
  return { title, readOnlyHint: false, destructiveHint: true, openWorldHint: false };
}

function formatTextResponse(value: unknown): ToolResult {
  return {
    content: [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.errors.map((entry) => entry.message).join("; ");
  if (error instanceof Error) return error.message;
  return String(error);
}

function redact(value: string, secretRedactions: string[]): string {
  let output = value;
  for (const secret of secretRedactions) {
    if (secret.length >= 8) output = output.split(secret).join("[REDACTED]");
  }
  return output.replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

function formatErrorResponse(error: unknown, secretRedactions: string[]): ToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: redact(errorMessage(error), secretRedactions),
    }],
  };
}

function makeTool<TSchema extends z.ZodRawShape>(
  options: GoogleSheetsToolOptions,
  name: string,
  description: string,
  risk: ToolRisk,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>) => Promise<unknown>,
): GoogleSheetsToolDefinition {
  return {
    name,
    description,
    schema,
    annotations: annotationsFor(description, risk),
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return formatTextResponse(await execute(parsed));
      } catch (error) {
        return formatErrorResponse(error, options.secretRedactions ?? []);
      }
    },
  };
}

function assertAllowed(allowedSpreadsheetIds: Set<string>, spreadsheetId: string) {
  if (!allowedSpreadsheetIds.has(spreadsheetId)) {
    throw new Error(`Spreadsheet ${spreadsheetId} is not in the configured allowlist.`);
  }
}

export function createToolDefinitions(options: GoogleSheetsToolOptions): GoogleSheetsToolDefinition[] {
  const allowedSpreadsheetIds = Array.from(new Set(options.allowedSpreadsheetIds.map((id) => id.trim()).filter(Boolean)));
  const allowedSpreadsheetIdSet = new Set(allowedSpreadsheetIds);
  if (allowedSpreadsheetIds.length === 0) {
    throw new Error("At least one allowed spreadsheet ID is required.");
  }

  return [
    makeTool(
      options,
      "list_spreadsheets",
      "List the Google Sheets spreadsheets configured in this connection allowlist.",
      "read",
      z.object({}),
      async () => options.client.listSpreadsheets(allowedSpreadsheetIds),
    ),
    makeTool(
      options,
      "get_spreadsheet_info",
      "Get spreadsheet metadata and sheet tab information for an allowlisted spreadsheet.",
      "read",
      spreadsheetToolSchema,
      async ({ spreadsheetId }) => {
        assertAllowed(allowedSpreadsheetIdSet, spreadsheetId);
        return options.client.getSpreadsheetInfo(spreadsheetId);
      },
    ),
    makeTool(
      options,
      "read_values",
      "Read cell values from an allowlisted spreadsheet range.",
      "read",
      readValuesSchema,
      async ({ spreadsheetId, range }) => {
        assertAllowed(allowedSpreadsheetIdSet, spreadsheetId);
        return options.client.readValues(spreadsheetId, range);
      },
    ),
    makeTool(
      options,
      "search_rows",
      "Search rows in an allowlisted spreadsheet range.",
      "read",
      searchRowsSchema,
      async (input) => {
        assertAllowed(allowedSpreadsheetIdSet, input.spreadsheetId);
        return options.client.searchRows(input);
      },
    ),
    makeTool(
      options,
      "append_rows",
      "Append rows to an allowlisted spreadsheet range.",
      "write",
      appendRowsSchema,
      async (input) => {
        assertAllowed(allowedSpreadsheetIdSet, input.spreadsheetId);
        return options.client.appendRows(input);
      },
    ),
    makeTool(
      options,
      "update_values",
      "Update values in an allowlisted spreadsheet range.",
      "write",
      updateValuesSchema,
      async (input) => {
        assertAllowed(allowedSpreadsheetIdSet, input.spreadsheetId);
        return options.client.updateValues(input);
      },
    ),
    makeTool(
      options,
      "add_sheet_tab",
      "Add a sheet tab to an allowlisted spreadsheet.",
      "write",
      addSheetTabSchema,
      async (input) => {
        assertAllowed(allowedSpreadsheetIdSet, input.spreadsheetId);
        return options.client.addSheetTab(input);
      },
    ),
    makeTool(
      options,
      "clear_values",
      "Clear values in an allowlisted spreadsheet range.",
      "destructive",
      readValuesSchema,
      async ({ spreadsheetId, range }) => {
        assertAllowed(allowedSpreadsheetIdSet, spreadsheetId);
        return options.client.clearValues(spreadsheetId, range);
      },
    ),
    makeTool(
      options,
      "delete_rows",
      "Delete rows from an allowlisted spreadsheet tab.",
      "destructive",
      deleteRowsSchema,
      async (input) => {
        assertAllowed(allowedSpreadsheetIdSet, input.spreadsheetId);
        if (input.endIndex <= input.startIndex) {
          throw new Error("endIndex must be greater than startIndex.");
        }
        return options.client.deleteRows(input);
      },
    ),
  ];
}
