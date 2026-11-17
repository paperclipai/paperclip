import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";
import { DRIVE_HOST, fileFields, fileId, fileIdInput, filePath, fileSchema, toMcpFile, writeScopeHint, type RestFile } from "./file.js";

const args = z.object({
  fileId,
  title: z.string().max(1024).optional(),
  parentId: fileId.optional(),
  pregeneratedId: fileId.optional(),
});
export type CopyFileArgs = z.infer<typeof args>;

export function copyFileRequest(input: CopyFileArgs): GoogleRequest {
  return {
    method: "POST",
    host: DRIVE_HOST,
    path: `${filePath(input.fileId)}/copy`,
    query: { fields: fileFields(), supportsAllDrives: true },
    body: compact({
      name: input.title || undefined,
      parents: input.parentId ? [input.parentId] : undefined,
      id: input.pregeneratedId,
    }),
  };
}

export function copyFileResult(file: RestFile): CallToolResult {
  return structuredResult(toMcpFile(file));
}

export const copyFile = defineTool({
  definition: {
    name: "copy_file",
    description: "Copies a Drive file into a new file and returns the copy. The original is not changed. Folders cannot be copied. Without title the copy gets Google's default name; without parentId Google places it next to the original when it can. Writes use Drive file access (drive.file), so Google may refuse a file or folder that this app did not create or open; the call then returns an error and nothing is copied.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: fileIdInput("ID of the file to copy."),
        title: { type: "string", description: "Optional. Title of the copy. Default: Google's default copy name." },
        parentId: { type: "string", description: "Optional. ID of the folder for the copy. Default: the original's folder." },
        pregeneratedId: { type: "string", description: "Optional. A Drive-generated ID to give the copy. Not for Google Docs, Sheets or Slides." },
      },
      required: ["fileId"],
    },
    outputSchema: fileSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  args,
  async run(input, http) {
    try {
      return copyFileResult(await http.send<RestFile>(copyFileRequest(input)));
    } catch (error) {
      throw writeScopeHint(error, input.parentId ? "the file or the target folder" : "the file");
    }
  },
});
