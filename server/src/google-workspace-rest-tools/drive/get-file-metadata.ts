import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { defineTool, structuredResult } from "../tool.js";
import {
  assertSnippetArgs,
  READ_LESS,
  fileFields,
  fileId,
  fileIdInput,
  fileSchema,
  getFileRequest,
  richMetadataInput,
  snippetArgs,
  snippetInputs,
  toMcpFile,
  type RestFile,
} from "./file.js";

const args = z.object({ fileId, includeRichMetadata: z.boolean().optional(), ...snippetArgs });
export type GetFileMetadataArgs = z.infer<typeof args>;

export function getFileMetadataResult(file: RestFile, rich: boolean): CallToolResult {
  return structuredResult(toMcpFile(file, rich));
}

export const getFileMetadata = defineTool({
  definition: {
    name: "get_file_metadata",
    description: "Gets a Drive file's metadata: title, type, size, parent folder, owner, times and link. Returns no content snippet; use read_file_content for the text. If the file is not found, find it with search_files.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: fileIdInput("ID of the file."),
        includeRichMetadata: richMetadataInput,
        ...snippetInputs,
      },
      required: ["fileId"],
    },
    outputSchema: fileSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  whenTooLarge: READ_LESS.metadata,
  async run(input, http) {
    assertSnippetArgs(input);
    const rich = input.includeRichMetadata === true;
    return getFileMetadataResult(await http.send<RestFile>(getFileRequest(input.fileId, fileFields(rich))), rich);
  },
});
