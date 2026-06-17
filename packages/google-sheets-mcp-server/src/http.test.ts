import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleSheetsMcpHttpServer, type GoogleSheetsMcpHttpServer } from "./http.js";
import type { GoogleSheetsMcpConfig } from "./config.js";
import type { GoogleSheetsClient } from "./google-client.js";

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

const servers: GoogleSheetsMcpHttpServer[] = [];

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

async function startServer(token?: string) {
  const googleClient = makeClient();
  const instance = createGoogleSheetsMcpHttpServer({
    config: makeConfig(),
    client: googleClient,
    token,
  });
  const port = await instance.listen(0, "127.0.0.1");
  servers.push(instance);
  return { googleClient, base: `http://127.0.0.1:${port}` };
}

async function mcpClient(base: string, headers?: Record<string, string>, path = "/mcp") {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}${path}`), {
    requestInit: headers ? { headers } : undefined,
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

afterEach(async () => {
  while (servers.length) {
    const instance = servers.pop();
    if (instance) await instance.close();
  }
});

describe("Google Sheets MCP HTTP server", () => {
  it("supports tools/list in unauthenticated loopback mode", async () => {
    const { base } = await startServer();
    const client = await mcpClient(base);

    try {
      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name)).toEqual(expectedTools);
    } finally {
      await client.close();
    }
  });

  it("supports tools/call with the mocked Google client", async () => {
    const { base, googleClient } = await startServer();
    const client = await mcpClient(base);

    try {
      const result = await client.callTool({
        name: "read_values",
        arguments: {
          spreadsheetId: "sheet-1",
          range: "Sheet1!A1:B2",
        },
      });

      expect(googleClient.readValues).toHaveBeenCalledWith("sheet-1", "Sheet1!A1:B2");
      expect(result.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("paper"),
        }),
      ]);
    } finally {
      await client.close();
    }
  });

  it("requires GOOGLE_SHEETS_MCP_TOKEN when configured", async () => {
    const token = "sheets-local-token";
    const { base, googleClient } = await startServer(token);

    expect((await fetch(`${base}/mcp`)).status).toBe(401);
    expect((await fetch(`${base}/mcp?token=${token}`)).status).not.toBe(401);

    const client = await mcpClient(base, { authorization: `Bearer ${token}` });
    try {
      await client.callTool({
        name: "append_rows",
        arguments: {
          spreadsheetId: "sheet-1",
          range: "Sheet1!A:B",
          values: [["paper", 12]],
          valueInputOption: "RAW",
        },
      });

      expect(googleClient.appendRows).toHaveBeenCalledWith({
        spreadsheetId: "sheet-1",
        range: "Sheet1!A:B",
        values: [["paper", 12]],
        valueInputOption: "RAW",
      });
    } finally {
      await client.close();
    }

    const queryClient = await mcpClient(base, undefined, `/mcp?token=${token}`);
    try {
      const list = await queryClient.listTools();
      expect(list.tools.map((tool) => tool.name)).toEqual(expectedTools);
    } finally {
      await queryClient.close();
    }
  });
});
