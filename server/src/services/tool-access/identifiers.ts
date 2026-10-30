import type { toolConnections } from "@paperclipai/db";


export function normalizeKey(input: string) {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 160) || "tool"
  );
}

export function connectionUid(namespace: string, name: string, connectionId: string) {
  return `${normalizeKey(namespace)}/${normalizeKey(name)}-${connectionId.slice(0, 8)}`;
}

export function connectionSetupUrl(connection: typeof toolConnections.$inferSelect) {
  return `/apps/${connection.id}/permissions`;
}

export function connectionReconnectUrl(
  connection: typeof toolConnections.$inferSelect,
) {
  return `/apps/${connection.id}/permissions`;
}
