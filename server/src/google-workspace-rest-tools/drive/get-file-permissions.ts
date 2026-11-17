import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import type { GoogleHttp, GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";
import { DRIVE_HOST, fileId, fileIdInput, filePath, READ_LESS, type RestPermission } from "./file.js";

const args = z.object({ fileId });
export type GetFilePermissionsArgs = z.infer<typeof args>;

export const PERMISSION_PAGE_SIZE = 100;
export const MAX_PERMISSION_PAGES = 10;
const ROLES = ["owner", "organizer", "fileOrganizer", "writer", "commenter", "reader"] as const;
const TYPES = ["user", "group", "domain", "anyone"] as const;
const VIEWS = ["published", "metadata"] as const;

interface RestPermissionList { permissions?: RestPermission[]; nextPageToken?: string }

export function permissionsRequest(id: string, pageToken?: string): GoogleRequest {
  return {
    method: "GET",
    host: DRIVE_HOST,
    path: `${filePath(id)}/permissions`,
    query: {
      pageSize: PERMISSION_PAGE_SIZE,
      pageToken,
      supportsAllDrives: true,
      fields: "nextPageToken,permissions(type,role,emailAddress,displayName,domain,view,deleted)",
    },
  };
}

export function toMcpPermission(permission: RestPermission): Record<string, unknown> {
  return compact({
    role: permission.role,
    displayName: permission.displayName ?? (permission.type === "domain" ? permission.domain : undefined),
    type: permission.type,
    emailAddress: permission.emailAddress,
    view: permission.view,
  });
}

export function getFilePermissionsResult(permissions: RestPermission[]): CallToolResult {
  return structuredResult({ permissions: permissions.filter((permission) => !permission.deleted).map(toMcpPermission) });
}

export async function readPermissions(id: string, http: GoogleHttp): Promise<RestPermission[]> {
  const permissions: RestPermission[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PERMISSION_PAGES; page += 1) {
    const list = await http.send<RestPermissionList>(permissionsRequest(id, pageToken));
    permissions.push(...(list.permissions ?? []));
    pageToken = list.nextPageToken || undefined;
    if (!pageToken) return permissions;
  }
  throw new GoogleToolError("too_large", `This file has more than ${MAX_PERMISSION_PAGES * PERMISSION_PAGE_SIZE} permissions, more than this tool returns.`);
}

export const getFilePermissions = defineTool({
  definition: {
    name: "get_file_permissions",
    description: "Lists who has access to a Drive file: each person, group, domain or link-sharing entry and its role. Google returns this only when the user may see the file's sharing.",
    inputSchema: {
      type: "object",
      properties: { fileId: fileIdInput("ID of the file.") },
      required: ["fileId"],
    },
    outputSchema: {
      type: "object",
      properties: {
        permissions: {
          type: "array",
          description: "The file's permissions.",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: [...ROLES], description: "The role granted." },
              displayName: { type: "string", description: "Name of the user or group, or the domain. Absent for anyone." },
              type: { type: "string", enum: [...TYPES], description: "Who the permission is for." },
              emailAddress: { type: "string", description: "Email address of the user or group." },
              view: { type: "string", enum: [...VIEWS], description: "The view the permission applies to, if any." },
            },
          },
        },
      },
      required: ["permissions"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  whenTooLarge: READ_LESS.permissions,
  async run(input, http) {
    return getFilePermissionsResult(await readPermissions(input.fileId, http));
  },
});
