import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { defineTool, structuredResult } from "../tool.js";
import { downloadPlan, fetchContent, readContentMeta } from "./content.js";
import { fileId, fileIdInput, mimeTypeArg, READ_LESS, revisionId, type RestFile } from "./file.js";

const args = z.object({ fileId, exportMimeType: mimeTypeArg.optional(), revisionId: revisionId.optional() });
export type DownloadFileContentArgs = z.infer<typeof args>;

export function downloadFileContentResult(id: string, file: RestFile, contentType: string, data: Buffer): CallToolResult {
  return structuredResult({ id, title: file.name ?? "", mimeType: contentType, content: data.toString("base64") });
}

export const downloadFileContent = defineTool({
  definition: {
    name: "download_file_content",
    description: "Downloads a Drive file's content as base64. Google Docs, Sheets, Slides, Drawings and Apps Script files are exported: by default Docs and Slides as text/plain, Sheets as text/csv (first sheet only; pass exportMimeType application/vnd.openxmlformats-officedocument.spreadsheetml.sheet for every sheet), Drawings as image/svg+xml, Apps Script as JSON. Other files are returned as stored. The whole result has a size limit; a file too large for it is refused with an error that gives the limit, never cut short. For a readable text version of a document, use read_file_content.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: fileIdInput("ID of the file to download."),
        exportMimeType: { type: "string", description: "Optional. For Google Docs, Sheets, Slides, Drawings and Apps Script files, the MIME type to export to, one of the formats Google lists for that file type (for example application/pdf or text/markdown for a Doc). Ignored for other files. Default: a text format." },
        revisionId: { type: "string", description: "Optional. ID of an earlier revision of this file to download. Only for files that are not Google Docs, Sheets, Slides or other Google files. Default: the current version." },
      },
      required: ["fileId"],
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The file's ID." },
        title: { type: "string", description: "The file's title." },
        mimeType: { type: "string", description: "MIME type of the returned content: the export format for Google files, otherwise the file's own type." },
        content: { type: "string", description: "The content, base64 encoded." },
      },
      required: ["id", "title", "mimeType", "content"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  whenTooLarge: READ_LESS.download,
  async run(input, http, limits) {
    const file = await readContentMeta(input.fileId, http);
    const plan = downloadPlan(input.fileId, file, input.exportMimeType, input.revisionId, READ_LESS.download, limits.maxResultBytes);
    return downloadFileContentResult(input.fileId, file, plan.contentType, await fetchContent(plan, http, READ_LESS.download, limits.maxResultBytes));
  },
});
