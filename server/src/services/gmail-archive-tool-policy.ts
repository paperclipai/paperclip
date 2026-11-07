import { badRequest } from "../errors.js";

type Connection = { config: Record<string, unknown> };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function leafName(name: string): string {
  return (name.split(/[.:/]/).pop() ?? name)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function isOfficialGmailConnection(connection: Connection): boolean {
  const config = connection.config;
  const profile = record(config.oauth).connectorProfile;
  if (
    config.sourceTemplateKey === "gmail"
    || profile === "gmail.read"
    || profile === "gmail.draft"
    || profile === "gmail.archive"
  ) return true;
  try {
    return new URL(String(config.url)).hostname === "gmailmcp.googleapis.com";
  } catch {
    return false;
  }
}

function isArchiveConnection(connection: Connection): boolean {
  const config = connection.config;
  return record(config.oauth).connectorProfile === "gmail.archive"
    || (config.sourceTemplateKey === "gmail"
      && (config.connectionMethodKey === "paperclip-archive"
        || config.connectionMethodKey === "customer-archive-oauth"));
}

function isUnlabelThread(connection: Connection, toolName: string): boolean {
  return isOfficialGmailConnection(connection) && leafName(toolName) === "unlabel-thread";
}

export function assertGmailArchiveToolArgumentsSupported(
  connection: Connection,
  toolName: string,
  parameters: unknown,
): void {
  if (!isUnlabelThread(connection, toolName)) return;
  if (!isArchiveConnection(connection)) {
    throw badRequest("Gmail archiving requires an explicit Read & archive connection.", {
      code: "gmail_archive_profile_required",
    });
  }
  const supplied = record(parameters);
  const keys = Object.keys(supplied).sort();
  if (
    keys.length !== 2
    || keys[0] !== "labelIds"
    || keys[1] !== "threadId"
    || typeof supplied.threadId !== "string"
    || supplied.threadId.trim().length === 0
    || !Array.isArray(supplied.labelIds)
    || supplied.labelIds.length !== 1
    || supplied.labelIds[0] !== "INBOX"
  ) {
    throw badRequest("Gmail archive accepts only threadId and labelIds: [\"INBOX\"].", {
      code: "gmail_archive_arguments_unsupported",
    });
  }
}

export function gmailArchiveToolInputSchema(
  connection: Connection,
  toolName: string,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!isUnlabelThread(connection, toolName) || !isArchiveConnection(connection)) return schema;
  return {
    type: "object",
    properties: {
      threadId: {
        type: "string",
        minLength: 1,
        description: "The Gmail thread ID to archive.",
      },
      labelIds: {
        type: "array",
        items: { type: "string", enum: ["INBOX"] },
        minItems: 1,
        maxItems: 1,
        description: "Must be exactly [\"INBOX\"].",
      },
    },
    required: ["threadId", "labelIds"],
    additionalProperties: false,
  };
}

export function gmailArchiveToolDescription(
  connection: Connection,
  toolName: string,
  description: string | null,
): string | null {
  return isUnlabelThread(connection, toolName) && isArchiveConnection(connection)
    ? "Archive a Gmail thread by removing only its Inbox label. Requires human approval."
    : description;
}
