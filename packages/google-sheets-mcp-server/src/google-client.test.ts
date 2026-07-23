import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleSheetsClient } from "./google-client.js";

const mocks = vi.hoisted(() => ({
  GoogleAuth: vi.fn(),
  sheets: vi.fn(),
  spreadsheetsGet: vi.fn(),
  valuesGet: vi.fn(),
  valuesAppend: vi.fn(),
  valuesUpdate: vi.fn(),
  valuesClear: vi.fn(),
  batchUpdate: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      GoogleAuth: mocks.GoogleAuth,
    },
    sheets: mocks.sheets,
  },
}));

const serviceAccount = {
  client_email: "service@example.test",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
  project_id: "project-1",
};

function resetGoogleapisMock() {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.GoogleAuth.mockImplementation(function GoogleAuth(this: { config?: unknown }, config: unknown) {
    this.config = config;
  });
  mocks.sheets.mockReturnValue({
    spreadsheets: {
      get: mocks.spreadsheetsGet,
      batchUpdate: mocks.batchUpdate,
      values: {
        get: mocks.valuesGet,
        append: mocks.valuesAppend,
        update: mocks.valuesUpdate,
        clear: mocks.valuesClear,
      },
    },
  });
}

describe("Google Sheets API client", () => {
  beforeEach(() => {
    resetGoogleapisMock();
  });

  it("creates a Sheets v4 client with service-account credentials", async () => {
    mocks.valuesGet.mockResolvedValueOnce({
      data: {
        range: "Sheet1!A1:B2",
        values: [["name", "amount"], ["paper", 12]],
      },
    });

    const client = createGoogleSheetsClient(serviceAccount);
    const values = await client.readValues("sheet-1", "Sheet1!A1:B2");

    expect(mocks.GoogleAuth).toHaveBeenCalledWith({
      credentials: serviceAccount,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    expect(mocks.sheets).toHaveBeenCalledWith({
      version: "v4",
      auth: { config: expect.any(Object) },
    });
    expect(mocks.valuesGet).toHaveBeenCalledWith({
      spreadsheetId: "sheet-1",
      range: "Sheet1!A1:B2",
    });
    expect(values.values).toEqual([["name", "amount"], ["paper", 12]]);
  });

  it("maps batchUpdate replies for add_sheet_tab and delete_rows", async () => {
    mocks.batchUpdate
      .mockResolvedValueOnce({
        data: {
          replies: [{
            addSheet: {
              properties: {
                sheetId: 12,
                title: "New",
                index: 2,
                gridProperties: { rowCount: 50, columnCount: 10 },
              },
            },
          }],
        },
      })
      .mockResolvedValueOnce({ data: {} });

    const client = createGoogleSheetsClient(serviceAccount);

    await expect(client.addSheetTab({
      spreadsheetId: "sheet-1",
      title: "New",
      rowCount: 50,
      columnCount: 10,
    })).resolves.toEqual({
      spreadsheetId: "sheet-1",
      sheet: {
        sheetId: 12,
        title: "New",
        index: 2,
        rowCount: 50,
        columnCount: 10,
      },
    });

    await expect(client.deleteRows({
      spreadsheetId: "sheet-1",
      sheetId: 12,
      startIndex: 3,
      endIndex: 5,
    })).resolves.toEqual({
      spreadsheetId: "sheet-1",
      sheetId: 12,
      deletedRows: 2,
    });

    expect(mocks.batchUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.batchUpdate).toHaveBeenLastCalledWith({
      spreadsheetId: "sheet-1",
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: 12,
              dimension: "ROWS",
              startIndex: 3,
              endIndex: 5,
            },
          },
        }],
      },
    });
  });
});
