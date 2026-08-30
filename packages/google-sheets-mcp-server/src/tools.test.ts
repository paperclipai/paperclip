import { describe, expect, it, vi } from "vitest";
import { createToolDefinitions } from "./tools.js";
import type { GoogleSheetsClient } from "./google-client.js";
import type { ToolResult } from "./tools.js";

function makeClient(): GoogleSheetsClient {
  return {
    listSpreadsheets: vi.fn().mockResolvedValue([
      { spreadsheetId: "sheet-1", title: "Budget", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1" },
    ]),
    getSpreadsheetInfo: vi.fn().mockResolvedValue({
      spreadsheetId: "sheet-1",
      title: "Budget",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
      sheets: [{ sheetId: 0, title: "Sheet1", index: 0, rowCount: 100, columnCount: 20 }],
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
    appendRows: vi.fn().mockResolvedValue({
      spreadsheetId: "sheet-1",
      range: "Sheet1!A:B",
      updatedRange: "Sheet1!A3:B3",
      updatedRows: 1,
      updatedCells: 2,
    }),
    updateValues: vi.fn().mockResolvedValue({
      spreadsheetId: "sheet-1",
      range: "Sheet1!A2:B2",
      updatedRange: "Sheet1!A2:B2",
      updatedRows: 1,
      updatedCells: 2,
    }),
    addSheetTab: vi.fn().mockResolvedValue({
      spreadsheetId: "sheet-1",
      sheet: { sheetId: 7, title: "New", index: 1, rowCount: 100, columnCount: 26 },
    }),
    clearValues: vi.fn().mockResolvedValue({
      spreadsheetId: "sheet-1",
      range: "Sheet1!A2:B2",
      updatedRange: "Sheet1!A2:B2",
    }),
    deleteRows: vi.fn().mockResolvedValue({
      spreadsheetId: "sheet-1",
      sheetId: 0,
      deletedRows: 2,
    }),
  };
}

function tools(client = makeClient()) {
  return createToolDefinitions({
    client,
    allowedSpreadsheetIds: ["sheet-1"],
    secretRedactions: ["secret-client@example.test", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"],
  });
}

function getTool(name: string, client?: GoogleSheetsClient) {
  const tool = tools(client).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function responseText(response: ToolResult) {
  const block = response.content.find((entry) => entry.type === "text");
  return block?.type === "text" ? block.text : "";
}

describe("Google Sheets MCP tools", () => {
  it("annotates tools with read, write, and destructive MCP risk hints", () => {
    const byName = new Map(tools().map((tool) => [tool.name, tool]));

    expect(byName.get("read_values")?.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.get("append_rows")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get("delete_rows")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("lists only allowlisted spreadsheets", async () => {
    const client = makeClient();
    const response = await getTool("list_spreadsheets", client).execute({});

    expect(client.listSpreadsheets).toHaveBeenCalledWith(["sheet-1"]);
    expect(responseText(response)).toContain("Budget");
  });

  it("allows calls for allowlisted spreadsheet IDs", async () => {
    const client = makeClient();
    const response = await getTool("read_values", client).execute({
      spreadsheetId: "sheet-1",
      range: "Sheet1!A1:B2",
    });

    expect(client.readValues).toHaveBeenCalledWith("sheet-1", "Sheet1!A1:B2");
    expect(response.isError).toBeUndefined();
    expect(responseText(response)).toContain("paper");
  });

  it("rejects calls outside the spreadsheet allowlist before calling Google", async () => {
    const client = makeClient();
    const response = await getTool("read_values", client).execute({
      spreadsheetId: "sheet-2",
      range: "Sheet1!A1:B2",
    });

    expect(response.isError).toBe(true);
    expect(responseText(response)).toContain("not in the configured allowlist");
    expect(client.readValues).not.toHaveBeenCalled();
  });

  it.each([
    ["get_spreadsheet_info", { spreadsheetId: "sheet-1" }, "getSpreadsheetInfo"],
    ["read_values", { spreadsheetId: "sheet-1", range: "Sheet1!A1:B2" }, "readValues"],
    ["search_rows", { spreadsheetId: "sheet-1", range: "Sheet1!A1:B2", query: "paper" }, "searchRows"],
    ["append_rows", { spreadsheetId: "sheet-1", range: "Sheet1!A:B", values: [["pen", 5]] }, "appendRows"],
    ["update_values", { spreadsheetId: "sheet-1", range: "Sheet1!A2:B2", values: [["pen", 6]] }, "updateValues"],
    ["add_sheet_tab", { spreadsheetId: "sheet-1", title: "New" }, "addSheetTab"],
    ["clear_values", { spreadsheetId: "sheet-1", range: "Sheet1!A2:B2" }, "clearValues"],
    ["delete_rows", { spreadsheetId: "sheet-1", sheetId: 0, startIndex: 1, endIndex: 3 }, "deleteRows"],
  ])("runs happy path for %s", async (toolName, input, clientMethod) => {
    const client = makeClient();
    const response = await getTool(toolName, client).execute(input);

    expect(response.isError).toBeUndefined();
    expect(client[clientMethod as keyof GoogleSheetsClient]).toHaveBeenCalled();
  });

  it("surfaces malformed Google range errors as tool errors", async () => {
    const client = makeClient();
    vi.mocked(client.readValues).mockRejectedValueOnce(new Error("Unable to parse range: Sheet1!bad"));

    const response = await getTool("read_values", client).execute({
      spreadsheetId: "sheet-1",
      range: "Sheet1!bad",
    });

    expect(response.isError).toBe(true);
    expect(responseText(response)).toContain("Unable to parse range");
  });

  it("does not echo service-account key material in tool errors", async () => {
    const client = makeClient();
    vi.mocked(client.readValues).mockRejectedValueOnce(
      new Error("Auth failed for secret-client@example.test using -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"),
    );

    const response = await getTool("read_values", client).execute({
      spreadsheetId: "sheet-1",
      range: "Sheet1!A1:B2",
    });

    expect(response.isError).toBe(true);
    expect(responseText(response)).not.toContain("secret-client@example.test");
    expect(responseText(response)).not.toContain("PRIVATE KEY");
    expect(responseText(response)).toContain("[REDACTED]");
  });
});
