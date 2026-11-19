export const SPREADSHEET_ID = "1SyntheticSheetId_0123456789abcdefghijklmn";

export const FORMATTED_VALUES = {
  range: "'Q1 Plan'!A1:D4",
  majorDimension: "ROWS",
  values: [
    ["Item", "Amount", "Due", "Paid"],
    ["Hosting", "$1,200.50", "1/5/2026", "TRUE"],
    ["Merged label", "", "12%"],
    ["", "", "", "#DIV/0!"],
  ],
};

export const EMPTY_VALUES = { range: "Sheet1!A1:Z100", majorDimension: "ROWS" };

export const SPREADSHEET_METADATA = {
  spreadsheetId: SPREADSHEET_ID,
  properties: { title: "Synthetic budget", locale: "en_US", timeZone: "America/New_York" },
  sheets: [
    { properties: { sheetId: 0, title: "Q1 Plan", index: 0, gridProperties: { rowCount: 1000, columnCount: 26, frozenRowCount: 1 } } },
    { properties: { sheetId: 7, title: "Bob's list", index: 1, gridProperties: { rowCount: 100, columnCount: 5 } } },
  ],
  spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`,
};

export const SPREADSHEET_WITH_GRID = {
  ...SPREADSHEET_METADATA,
  sheets: [{
    properties: SPREADSHEET_METADATA.sheets[0]!.properties,
    merges: [{ sheetId: 0, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 2 }],
    data: [{
      startRow: 0,
      rowData: [
        { values: [
          { userEnteredValue: { stringValue: "Due" }, effectiveValue: { stringValue: "Due" }, formattedValue: "Due" },
          { userEnteredValue: { numberValue: 46027 }, effectiveValue: { numberValue: 46027 }, formattedValue: "1/5/2026", userEnteredFormat: { numberFormat: { type: "DATE", pattern: "M/d/yyyy" } } },
        ] },
        { values: [
          { userEnteredValue: { formulaValue: "=SUM(B1:B2)" }, effectiveValue: { numberValue: 1200.5 }, formattedValue: "$1,200.50" },
        ] },
      ],
    }],
  }],
};

export const UPDATE_VALUES_RESPONSE = {
  spreadsheetId: SPREADSHEET_ID,
  updatedRange: "'Q1 Plan'!A1:B2",
  updatedRows: 2,
  updatedColumns: 2,
  updatedCells: 4,
};

export const BATCH_UPDATE_RESPONSE = { spreadsheetId: SPREADSHEET_ID, replies: [{}] };
