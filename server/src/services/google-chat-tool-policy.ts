import { badRequest } from "../errors.js";

type Connection = { config: Record<string, unknown> };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isChatSearch(connection: Connection, toolName: string): boolean {
  const leaf = (toolName.split(/[.:/]/).pop() ?? toolName)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();
  if (leaf !== "search-messages") return false;
  const config = connection.config;
  const profile = record(config.oauth).connectorProfile;
  if (config.sourceTemplateKey === "google-chat" || profile === "chat.read" || profile === "chat.write") return true;
  // Also cover existing URL-only connections to the official Chat server.
  try {
    return new URL(String(config.url)).hostname === "chatmcp.googleapis.com";
  } catch {
    return false;
  }
}

const UNREAD_FIELDS = new Set(["isUnread", "is_unread"]);

export function assertGoogleChatToolArgumentsSupported(
  connection: Connection,
  toolName: string,
  parameters: unknown,
): void {
  if (!isChatSearch(connection, toolName)) return;
  const supplied = record(parameters);
  // Reject presence, including false/null, rather than silently changing the
  // requested search. Accept neither proto JSON nor snake_case read-state keys.
  for (const candidate of [supplied, record(supplied.searchParameters), record(supplied.search_parameters)]) {
    if ([...UNREAD_FIELDS].some((key) => Object.hasOwn(candidate, key))) {
      throw badRequest(
        "Google Chat read/unread filtering is not supported. Omit isUnread and search by keywords, conversation, sender, or dates instead.",
        { code: "google_chat_unread_filter_unsupported" },
      );
    }
  }
  for (const key of ["searchParameters", "search_parameters"]) {
    if (Object.hasOwn(supplied, key) && record(supplied[key]) !== supplied[key]) {
      throw badRequest("Google Chat searchParameters must be an object, not encoded JSON or text.", {
        code: "google_chat_search_parameters_invalid",
      });
    }
  }
}

function withoutUnreadFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUnreadFields);
  if (value === null || typeof value !== "object") return value;
  // Walk inline schemas, composition branches, and $defs/definitions so a
  // provider changing schema layout cannot advertise the unsupported filter.
  return Object.fromEntries(Object.entries(record(value)).map(([key, child]) => {
    if (key === "properties") {
      return [key, Object.fromEntries(Object.entries(record(child))
        .filter(([name]) => !UNREAD_FIELDS.has(name))
        .map(([name, schema]) => [name, withoutUnreadFields(schema)]))];
    }
    if (key === "required" && Array.isArray(child)) {
      return [key, child.filter((name) => !UNREAD_FIELDS.has(name))];
    }
    return [key, withoutUnreadFields(child)];
  }));
}

export function googleChatToolInputSchema(
  connection: Connection,
  toolName: string,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return isChatSearch(connection, toolName)
    ? withoutUnreadFields(schema) as Record<string, unknown>
    : schema;
}

export function googleChatToolDescription(
  connection: Connection,
  toolName: string,
  description: string | null,
): string | null {
  return isChatSearch(connection, toolName)
    ? "Search Google Chat messages by keywords, conversation, sender, mentions, links, or dates. Read/unread filtering is not supported."
    : description;
}
