# Output Contract

Use this contract for every Numbers standardization task.

## Required Files

```text
normalized/
  <table-name>.csv
writeback/
  writeback-plan.json
  standardization-summary.md
```

## `writeback-plan.json`

```json
{
  "sourceDocument": "/absolute/path/to/source.numbers",
  "generatedAt": "2026-03-12T10:00:00Z",
  "assumptions": [
    "The sheet named 'Transactions' maps to the exported transactions CSV."
  ],
  "tables": [
    {
      "tableId": "transactions",
      "sheetName": "Transactions",
      "tableName": "Transactions",
      "inputFile": "normalized/transactions.csv",
      "matchStrategy": {
        "type": "primary_key",
        "columns": ["transaction_id"]
      },
      "writeMode": "upsert",
      "columns": [
        {
          "name": "transaction_id",
          "type": "string",
          "sourceHeaders": ["Transaction ID"]
        },
        {
          "name": "trade_date",
          "type": "date",
          "sourceHeaders": ["Trade Date"],
          "format": "YYYY-MM-DD"
        },
        {
          "name": "amount_usd",
          "type": "currency",
          "sourceHeaders": ["Amount", "Currency"],
          "currency": "USD"
        },
        {
          "name": "category",
          "type": "enum",
          "sourceHeaders": ["Category"],
          "mapping": {
            "ai infra": "AI Infrastructure",
            "AI infra": "AI Infrastructure",
            "infra": "AI Infrastructure"
          }
        }
      ],
      "manualReview": [
        {
          "rowRef": "transaction_id=TX-1042",
          "reason": "Currency code missing; amount could not be normalized safely."
        }
      ]
    }
  ]
}
```

## Field Rules

- `sourceDocument`: absolute path to the original `.numbers` file
- `generatedAt`: ISO-8601 timestamp
- `assumptions`: only list assumptions that affect normalization or writeback
- `tableId`: stable slug used by tooling
- `sheetName`: exact target sheet name in Numbers
- `tableName`: exact target table name when known; repeat the visible table name
  or set to the sheet's primary table if the workbook is single-table
- `inputFile`: relative path to the normalized CSV that should be written back
- `matchStrategy.type`: one of `primary_key`, `composite_key`, `row_position`
- `matchStrategy.columns`: required for key-based strategies
- `writeMode`: one of `replace`, `upsert`, `append`
- `columns`: canonical writeback columns in final order
- `manualReview`: rows or cells that need human inspection before writeback

Use `row_position` only when no stable key exists. Call out that risk in the
summary.

## `standardization-summary.md`

Keep this file short and operational. Use this structure:

```md
# Standardization Summary

## Source

- Document: `/absolute/path/to/source.numbers`
- Tables: `transactions`

## Assumptions

- Assumption 1

## Transformations

- Renamed `Trade Date` to `trade_date`
- Converted mixed `MM/DD/YYYY` and `YYYY-MM-DD` values to `YYYY-MM-DD`
- Normalized currency values into USD

## Manual Review

- `transaction_id=TX-1042`: currency code missing

## Writeback Notes

- Target sheet: `Transactions`
- Match strategy: primary key on `transaction_id`
- Write mode: upsert
```

## CSV Rules

- UTF-8
- header row required
- canonical columns only
- one row per logical record
- dates and datetimes already normalized before writeback
- no decorative columns such as notes unless explicitly requested
