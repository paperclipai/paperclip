import { assertRequestKinds, type RequestKindRules } from "./documents-shared.js";
import { DOCS_REQUEST_KINDS } from "./docs/request-kinds.js";
import { GoogleToolError } from "./errors.js";
import { SLIDES_REQUEST_KINDS } from "./slides/request-kinds.js";
import { unknownArgumentProblems, type JsonSchemaNode } from "./tool.js";
import type { GoogleWorkspaceRestService } from "./tools.js";

const FILE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const FILE_ID_ARGUMENTS: Partial<Record<GoogleWorkspaceRestService, readonly string[]>> = {
  drive: ["fileId", "parentId"],
  docs: ["documentId"],
  sheets: ["spreadsheetId"],
  slides: ["presentationId"],
};
const REQUEST_KINDS: Partial<Record<GoogleWorkspaceRestService, Partial<Record<string, RequestKindRules>>>> = {
  docs: { update_doc: DOCS_REQUEST_KINDS },
  slides: { update_presentation: SLIDES_REQUEST_KINDS },
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function closedAtTopOrDeclared(schema: JsonSchemaNode, path: string): schema is JsonSchemaNode & { properties: Record<string, JsonSchemaNode> } {
  if (!isRecord(schema.properties)) return false;
  return schema.additionalProperties === false || (path === "" && schema.additionalProperties === undefined);
}

export interface GoogleWorkspaceArgumentCheck {
  service: GoogleWorkspaceRestService;
  toolName: string;
  arguments: unknown;
  inputSchema: unknown;
}

export function googleWorkspaceArgumentRefusal(check: GoogleWorkspaceArgumentCheck): string | null {
  const args = check.arguments ?? {};
  if (!isRecord(args)) return refusal(check.toolName, "arguments must be an object.");
  const unknown = unknownArgumentProblems(args, check.inputSchema, "", closedAtTopOrDeclared);
  if (unknown.length > 0) return refusal(check.toolName, unknown.join(" "));
  for (const name of FILE_ID_ARGUMENTS[check.service] ?? []) {
    const value = args[name];
    if (value !== undefined && (typeof value !== "string" || !FILE_ID.test(value))) {
      return refusal(check.toolName, `${name} must be one Google file ID (letters, digits, - and _), not a link or a list.`);
    }
  }
  const rules = REQUEST_KINDS[check.service]?.[check.toolName];
  if (rules && args.requests !== undefined) {
    const requests = args.requests;
    if (!Array.isArray(requests) || requests.some((request) => !isRecord(request) || Object.keys(request).length !== 1)) {
      return refusal(check.toolName, "requests must be a list in which each request names exactly one kind of update, such as insertText.");
    }
    try {
      assertRequestKinds(requests as Array<Record<string, unknown>>, rules);
    } catch (error) {
      if (error instanceof GoogleToolError) return refusal(check.toolName, error.message);
      throw error;
    }
  }
  return null;
}

function refusal(toolName: string, detail: string): string {
  return `Invalid arguments for ${toolName}: ${detail} Nothing was sent to Google.`;
}
