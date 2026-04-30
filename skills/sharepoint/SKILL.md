---
name: sharepoint
description: >
  Read and write files on the Medicodio SharePoint site (MedicodioMarketing).
  Use when you need to read documents, update reports, create files, list folder
  contents, search files, or manage the SharePoint document library as part of
  a task assigned in Paperclip. Do NOT use for non-SharePoint file operations.
---

# SharePoint Skill

You have access to the **Medicodio Marketing SharePoint site** via MCP tools.  
Site: `https://medicodio.sharepoint.com/sites/MedicodioMarketing`

Credentials are injected automatically as env vars:
- `SHAREPOINT_TENANT_ID`
- `SHAREPOINT_CLIENT_ID`
- `SHAREPOINT_CLIENT_SECRET`
- `SHAREPOINT_SITE_URL` (defaults to the Marketing site above)

The MCP server (`sharepoint-mcp-server`) exposes these tools:

## Available Tools

| Tool | Purpose |
|------|---------|
| `sharepoint_list_drives` | List all document libraries in the site |
| `sharepoint_list_root` | List files/folders at drive root |
| `sharepoint_list_folder` | List contents of a specific folder by path |
| `sharepoint_get_file_info` | Get metadata: size, modified date, webUrl |
| `sharepoint_read_file` | Read text content of a file (.txt, .md, .csv, .json, .html) |
| `sharepoint_write_file` | Create or overwrite a file with text content |
| `sharepoint_create_folder` | Create a new folder |
| `sharepoint_search` | Search files and folders by keyword |
| `sharepoint_move_item` | Move or rename a file/folder |
| `sharepoint_delete_item` | Delete a file or folder permanently |
| `sharepoint_excel_list_sheets` | List all worksheets in an .xlsx file |
| `sharepoint_excel_add_sheet` | Add a new worksheet to an .xlsx file |
| `sharepoint_excel_read_range` | Read cell values from a worksheet (full sheet or range like 'A1:D10') |
| `sharepoint_excel_write_range` | Write cell values to a worksheet range |

## Usage Patterns

### Reading a document
```
1. sharepoint_list_root → find the file or folder path
2. sharepoint_read_file filePath="Documents/report.txt" → read content
```

### Updating a report
```
1. sharepoint_read_file filePath="Reports/weekly.md" → get current content
2. Modify content in memory
3. sharepoint_write_file filePath="Reports/weekly.md" content="..." → save
```

### Creating a structured output
```
1. sharepoint_create_folder parentPath="Outputs" folderName="2026-Q2"
2. sharepoint_write_file filePath="Outputs/2026-Q2/summary.md" content="..."
```

### Finding a file
```
sharepoint_search query="marketing brief" → returns matching files with paths
```

## Important Rules

1. **Always confirm the path exists** before writing: use `sharepoint_get_file_info` or `sharepoint_list_folder` first if unsure.
2. **`sharepoint_write_file` overwrites** — do not overwrite without reading first if preserving existing content matters.
3. **`sharepoint_delete_item` is permanent** — confirm the task explicitly requires deletion before using.
4. **Excel files** (`.xlsx`): use `sharepoint_excel_*` tools — NOT `sharepoint_write_file`. Read/write cells via the Graph Excel API. For `.docx`/`.pdf`, use `sharepoint_get_file_info` to get `webUrl` and reference it in comments.
5. **Paths are relative to drive root** — do not include a leading `/`.

## MCP Server Setup

The MCP server binary is `sharepoint-mcp-server` (from `@paperclipai/mcp-sharepoint`).

### In agent `adapterConfig` (Paperclip UI)

Add to agent's extra args:
```json
{
  "extraArgs": ["--mcp-config", "/path/to/sharepoint-mcp.json"]
}
```

Or configure in the agent's home `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "sharepoint": {
      "command": "sharepoint-mcp-server",
      "env": {
        "SHAREPOINT_TENANT_ID": "<from company_secrets>",
        "SHAREPOINT_CLIENT_ID": "<from company_secrets>",
        "SHAREPOINT_CLIENT_SECRET": "<from company_secrets>"
      }
    }
  }
}
```

### Secret references in Paperclip agent config

Store secrets in Paperclip (Settings → Secrets), then reference in agent env:
```json
{
  "env": {
    "SHAREPOINT_TENANT_ID": { "type": "secret_ref", "secretId": "<id>" },
    "SHAREPOINT_CLIENT_ID": { "type": "secret_ref", "secretId": "<id>" },
    "SHAREPOINT_CLIENT_SECRET": { "type": "secret_ref", "secretId": "<id>" }
  }
}
```
Paperclip resolves these to actual values before passing to the agent process.
