# Google Sheets MCP Server

First-party MCP server for Google Sheets API v4. It can run as a Paperclip
`local_stdio` gallery connection or as a local Streamable HTTP server for
Paperclip's `remote_http` connect-by-link flow.

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

## Paperclip `local_stdio` Test Path

Use the Google Sheets gallery app when you want Paperclip to supervise the
server as a stdio MCP process:

1. Configure Paperclip's Google Sheets service account environment so the
   gallery marks Google Sheets as available. The service account JSON must be
   provided by `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` or
   `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_PATH`.
2. Share every spreadsheet you want to test with the service account's
   `client_email`.
3. In Paperclip, open the tool app gallery, choose **Google Sheets**, and paste
   one or more Google Sheets links.
4. Save the app connection. Paperclip creates a `local_stdio` connection using
   the `paperclip.google-sheets` template and passes the selected spreadsheet
   IDs to this server as `GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS`.
5. Refresh the tool catalog and verify the Google Sheets tools appear for the
   connection.

In this path, the spreadsheet allowlist comes from the gallery wizard. Every
tool call is still checked against the server-side allowlist before the server
calls Google.

## Paperclip `remote_http` Test Path

Use the HTTP binary when you want to exercise the same tools through
Paperclip's `remote_http` gateway:

```sh
GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_PATH=/path/to/service-account.json \
GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS=sheet_id_1,sheet_id_2 \
GOOGLE_SHEETS_MCP_HOST=127.0.0.1 \
GOOGLE_SHEETS_MCP_PORT=8849 \
GOOGLE_SHEETS_MCP_TOKEN=local-test-token \
paperclip-google-sheets-mcp-http-server
```

The HTTP server prints the MCP endpoint on startup. With the values above, use:

```text
http://127.0.0.1:8849/mcp
```

Then in Paperclip, choose the remote HTTP or "connect with a link" path, paste
the `/mcp` URL, and configure the bearer token if `GOOGLE_SHEETS_MCP_TOKEN` is
set. The HTTP server accepts the token as either an `Authorization: Bearer
<token>` header or a `?token=<token>` query parameter; the Paperclip connection
should use the bearer-header form for normal testing.

HTTP configuration:

- `GOOGLE_SHEETS_MCP_HOST`: host to bind. Defaults to `127.0.0.1`.
- `GOOGLE_SHEETS_MCP_PORT`: port to bind. Defaults to `8849`.
- `PORT`: platform-style port override. When set, it takes precedence over
  `GOOGLE_SHEETS_MCP_PORT`.
- `GOOGLE_SHEETS_MCP_TOKEN`: optional shared secret for the `/mcp` route. Omit
  only for loopback/local testing where no other process can reach the server.

The HTTP server reuses the same service-account and spreadsheet allowlist
environment as stdio. In this phase, the HTTP spreadsheet allowlist is
process-level configuration (`GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS` or
`GOOGLE_SHEETS_SPREADSHEET_IDS`), not a per-connection Paperclip gallery wizard
setting. Restart the HTTP process with a different allowlist when you need to
test a different spreadsheet set.

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
