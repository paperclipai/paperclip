# Google Sheets MCP Server

First-party stdio MCP server for Google Sheets API v4.

## Configuration

The server uses Google service-account credentials only. OAuth is intentionally
not supported in v1.

Required:

- `GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS`: comma or newline separated spreadsheet
  IDs the server may access.
- One of:
  - `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON`: inline service-account JSON, or a path
    to a service-account JSON file.
  - `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_PATH`: path to a service-account JSON
    file.

Equivalent CLI flags are available for local stdio templates:

```sh
paperclip-google-sheets-mcp-server \
  --service-account-json-path /path/to/service-account.json \
  --allowed-spreadsheet-ids sheet_id_1,sheet_id_2
```

Share each allowed spreadsheet with the service account's `client_email`.

## Tools

- `list_spreadsheets` (read)
- `get_spreadsheet_info` (read)
- `read_values` (read)
- `search_rows` (read)
- `append_rows` (write)
- `update_values` (write)
- `add_sheet_tab` (write)
- `clear_values` (destructive)
- `delete_rows` (destructive)

Every tool that accepts a spreadsheet ID rejects IDs outside the configured
allowlist before calling Google. `list_spreadsheets` lists only the allowlisted
IDs.
