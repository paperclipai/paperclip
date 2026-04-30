import { z } from "zod";
import { SharepointClient } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  execute: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

function makeTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>, client: SharepointClient) => Promise<unknown>,
  client: SharepointClient,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return formatTextResponse(await execute(parsed, client));
      } catch (error) {
        return formatErrorResponse(error);
      }
    },
  };
}

const driveIdOpt = z.string().optional().describe("Drive ID (omit for default document library)");
const filePathDesc = "File path relative to drive root, e.g. 'Documents/report.docx'";
const folderPathDesc = "Folder path relative to drive root, e.g. 'Documents/Reports'";

export function createToolDefinitions(client: SharepointClient): ToolDefinition[] {
  return [
    // ── List drives ───────────────────────────────────────────────────────────
    makeTool(
      "sharepoint_list_drives",
      "List all document libraries (drives) in the SharePoint site.",
      z.object({}),
      async () => client.listDrives(),
      client,
    ),

    // ── List root files ───────────────────────────────────────────────────────
    makeTool(
      "sharepoint_list_root",
      "List files and folders at the root of the default document library (or a specific drive).",
      z.object({ driveId: driveIdOpt }),
      async ({ driveId }) => client.listRootFiles(driveId),
      client,
    ),

    // ── List folder ───────────────────────────────────────────────────────────
    makeTool(
      "sharepoint_list_folder",
      "List files and folders inside a folder by path.",
      z.object({
        folderPath: z.string().describe(folderPathDesc),
        driveId: driveIdOpt,
      }),
      async ({ folderPath, driveId }) => client.listByPath(folderPath, driveId),
      client,
    ),

    // ── Get file info ─────────────────────────────────────────────────────────
    makeTool(
      "sharepoint_get_file_info",
      "Get metadata about a file or folder (size, modified date, webUrl, etc.).",
      z.object({
        filePath: z.string().describe(filePathDesc),
        driveId: driveIdOpt,
      }),
      async ({ filePath, driveId }) => client.getItemByPath(filePath, driveId),
      client,
    ),

    // ── Read file ─────────────────────────────────────────────────────────────
    makeTool(
      "sharepoint_read_file",
      "Read the text content of a file. Works best for .txt, .md, .csv, .json, .html files. Binary files (docx, xlsx, pdf) return raw bytes as text — use get_file_info + webUrl to open those in a browser instead.",
      z.object({
        filePath: z.string().describe(filePathDesc),
        driveId: driveIdOpt,
      }),
      async ({ filePath, driveId }) => client.readFileContent(filePath, driveId),
      client,
    ),

    // ── Write file ────────────────────────────────────────────────────────────
    makeTool(
      "sharepoint_write_file",
      "Create or overwrite a file with text content. Creates intermediate folders if they don't exist. Use for .txt, .md, .csv, .json, .html files.",
      z.object({
        filePath: z.string().describe(filePathDesc),
        content: z.string().describe("File content to write"),
        driveId: driveIdOpt,
      }),
      async ({ filePath, content, driveId }) => client.writeFile(filePath, content, driveId),
      client,
    ),

    // ── Upload binary ─────────────────────────────────────────────────────────
    makeTool(
      "sharepoint_upload_binary",
      "Upload a binary file (PDF, image, DOCX, etc.) to SharePoint using base64-encoded content. Use the contentBytes field returned by outlook_read_attachment. Overwrites if the file already exists.",
      z.object({
        filePath: z.string().describe(filePathDesc),
        contentBase64: z.string().describe("Base64-encoded file content (contentBytes from outlook_read_attachment)"),
        mimeType: z.string().describe("MIME type of the file, e.g. 'application/pdf', 'image/jpeg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'"),
        driveId: driveIdOpt,
      }),
      async ({ filePath, contentBase64, mimeType, driveId }) =>
        client.uploadBinary(filePath, contentBase64, mimeType, driveId),
      client,
    ),

    // ── Create folder ─────────────────────────────────────────────────────────
    makeTool(
      "sharepoint_create_folder",
      "Create a new folder inside a parent folder (or root if parentPath is empty).",
      z.object({
        parentPath: z
          .string()
          .default("")
          .describe("Parent folder path (empty string = drive root)"),
        folderName: z.string().describe("Name of the new folder"),
        driveId: driveIdOpt,
      }),
      async ({ parentPath, folderName, driveId }) =>
        client.createFolder(parentPath, folderName, driveId),
      client,
    ),

    // ── Search ────────────────────────────────────────────────────────────────
    makeTool(
      "sharepoint_search",
      "Search for files and folders in the SharePoint site by keyword.",
      z.object({
        query: z.string().describe("Search query"),
        driveId: driveIdOpt,
      }),
      async ({ query, driveId }) => client.searchFiles(query, driveId),
      client,
    ),

    // ── Move / Rename ─────────────────────────────────────────────────────────
    makeTool(
      "sharepoint_move_item",
      "Move a file or folder to a different location, optionally renaming it.",
      z.object({
        sourcePath: z.string().describe("Current path of the file or folder"),
        destFolderPath: z
          .string()
          .default("")
          .describe("Destination folder path (empty = drive root)"),
        newName: z
          .string()
          .optional()
          .describe("New name for the item (omit to keep current name)"),
        driveId: driveIdOpt,
      }),
      async ({ sourcePath, destFolderPath, newName, driveId }) =>
        client.moveItem(sourcePath, destFolderPath, newName, driveId),
      client,
    ),

    // ── Excel: list sheets ────────────────────────────────────────────────────
    makeTool(
      "sharepoint_excel_list_sheets",
      "List all worksheets in an Excel (.xlsx) file on SharePoint.",
      z.object({
        filePath: z.string().describe(filePathDesc),
        driveId: driveIdOpt,
      }),
      async ({ filePath, driveId }) => client.excelListSheets(filePath, driveId),
      client,
    ),

    // ── Excel: add sheet ──────────────────────────────────────────────────────
    makeTool(
      "sharepoint_excel_add_sheet",
      "Add a new worksheet to an existing Excel (.xlsx) file on SharePoint.",
      z.object({
        filePath: z.string().describe(filePathDesc),
        sheetName: z.string().describe("Name for the new worksheet"),
        driveId: driveIdOpt,
      }),
      async ({ filePath, sheetName, driveId }) => client.excelAddSheet(filePath, sheetName, driveId),
      client,
    ),

    // ── Excel: read range ─────────────────────────────────────────────────────
    makeTool(
      "sharepoint_excel_read_range",
      "Read cell values from a worksheet in an Excel file. Omit address to read the entire used range.",
      z.object({
        filePath: z.string().describe(filePathDesc),
        sheetName: z.string().describe("Worksheet name, e.g. 'Sheet1'"),
        address: z.string().default("").describe("Cell range e.g. 'A1:D10' (empty = full used range)"),
        driveId: driveIdOpt,
      }),
      async ({ filePath, sheetName, address, driveId }) =>
        client.excelReadRange(filePath, sheetName, address, driveId),
      client,
    ),

    // ── Excel: write range ────────────────────────────────────────────────────
    makeTool(
      "sharepoint_excel_write_range",
      "Write cell values to a range in a worksheet in an Excel file. values is a 2D array [[row1col1, row1col2], [row2col1, ...]]. Creates the range if empty.",
      z.object({
        filePath: z.string().describe(filePathDesc),
        sheetName: z.string().describe("Worksheet name to write to"),
        address: z.string().describe("Top-left cell or range, e.g. 'A1' or 'A1:B3'"),
        values: z.array(z.array(z.unknown())).describe("2D array of cell values"),
        driveId: driveIdOpt,
      }),
      async ({ filePath, sheetName, address, values, driveId }) =>
        client.excelWriteRange(filePath, sheetName, address, values, driveId),
      client,
    ),

    // ── Transfer from Outlook ─────────────────────────────────────────────────
    makeTool(
      "sharepoint_transfer_from_outlook",
      "Download an Outlook email attachment and upload it directly to SharePoint — binary never passes through the agent context window. Use instead of outlook_read_attachment + sharepoint_upload_binary for any file (PDF, image, DOCX, etc.). Requires OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, and OUTLOOK_MAILBOX env vars on the sharepoint MCP server.",
      z.object({
        messageId: z.string().describe("Outlook message ID from outlook_list_attachments or outlook_search_emails"),
        attachmentId: z.string().describe("Attachment ID from outlook_list_attachments"),
        destPath: z.string().describe(filePathDesc + " — destination path in SharePoint, e.g. 'HR-Onboarding/John Doe - 2026-05-01/01_Raw_Submissions/resume.pdf'"),
        mimeType: z.string().default("application/octet-stream").describe("MIME type of the file, e.g. 'application/pdf', 'image/jpeg'. Defaults to application/octet-stream if unknown."),
        driveId: driveIdOpt,
      }),
      async ({ messageId, attachmentId, destPath, mimeType, driveId }) =>
        client.transferFromOutlook(messageId, attachmentId, destPath, mimeType, driveId),
      client,
    ),

    // ── Delete ────────────────────────────────────────────────────────────────
    makeTool(
      "sharepoint_delete_item",
      "Delete a file or folder permanently. Cannot be undone.",
      z.object({
        itemPath: z.string().describe("Path to the file or folder to delete"),
        driveId: driveIdOpt,
      }),
      async ({ itemPath, driveId }) => {
        await client.deleteItem(itemPath, driveId);
        return { deleted: true, path: itemPath };
      },
      client,
    ),
  ];
}
