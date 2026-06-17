import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { createGoogleSheetsMcpServer } from "./index.js";
import type { GoogleSheetsClient } from "./google-client.js";
import type { GoogleSheetsMcpConfig } from "./config.js";

const expectedTools = [
  "list_spreadsheets",
  "get_spreadsheet_info",
  "read_values",
  "search_rows",
  "append_rows",
  "update_values",
  "add_sheet_tab",
  "clear_values",
  "delete_rows",
];

function makeConfig(): GoogleSheetsMcpConfig {
  return {
    serviceAccount: {
      client_email: "service@example.test",
      private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
    },
    allowedSpreadsheetIds: ["sheet-1"],
    secretRedactions: ["service@example.test", "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----"],
  };
}

function makeClient(): GoogleSheetsClient {
  return {
    listSpreadsheets: vi.fn().mockResolvedValue([
      { spreadsheetId: "sheet-1", title: "Budget", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1" },
    ]),
    getSpreadsheetInfo: vi.fn().mockResolvedValue({
      spreadsheetId: "sheet-1",
      title: "Budget",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
      sheets: [],
    }),
    readValues: vi.fn().mockResolvedValue({
      spreadsheetId: "sheet-1",
      range: "Sheet1!A1:B2",
      values: [["name", "amount"], ["paper", 12]],
    }),
    searchRows: vi.fn().mockResolvedValue({
      spreadsheetId: "sheet-1",
      range: "Sheet1!A1:B2",
      query: "paper",
      matches: [{ rowIndex: 2, values: ["paper", 12] }],
    }),
    appendRows: vi.fn().mockResolvedValue({ spreadsheetId: "sheet-1", range: "Sheet1!A:B", updatedRows: 1 }),
    updateValues: vi.fn().mockResolvedValue({ spreadsheetId: "sheet-1", range: "Sheet1!A2:B2", updatedRows: 1 }),
    addSheetTab: vi.fn().mockResolvedValue({
      spreadsheetId: "sheet-1",
      sheet: { sheetId: 1, title: "New", index: 1, rowCount: null, columnCount: null },
    }),
    clearValues: vi.fn().mockResolvedValue({ spreadsheetId: "sheet-1", range: "Sheet1!A2:B2" }),
    deleteRows: vi.fn().mockResolvedValue({ spreadsheetId: "sheet-1", sheetId: 0, deletedRows: 1 }),
  };
}

function firstText(result: CallToolResult) {
  const block = result.content.find((entry) => entry.type === "text");
  return block?.type === "text" ? block.text : "";
}

describe("Google Sheets MCP server protocol", () => {
  it("supports tools/list and tools/call over MCP transports with a mocked Google client", async () => {
    const googleClient = makeClient();
    const { server } = createGoogleSheetsMcpServer(makeConfig(), { client: googleClient });
    const mcpClient = new Client({ name: "test-client", version: "0.1.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      mcpClient.connect(clientTransport),
    ]);

    try {
      const list = await mcpClient.listTools();
      expect(list.tools.map((tool) => tool.name)).toEqual(expectedTools);
      expect(list.tools.find((tool) => tool.name === "delete_rows")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });

      const result = await mcpClient.callTool(
        {
          name: "read_values",
          arguments: {
            spreadsheetId: "sheet-1",
            range: "Sheet1!A1:B2",
          },
        },
        CallToolResultSchema,
      );

      expect(googleClient.readValues).toHaveBeenCalledWith("sheet-1", "Sheet1!A1:B2");
      expect("content" in result).toBe(true);
      expect(firstText(result as CallToolResult)).toContain("paper");
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});
