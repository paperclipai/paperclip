/** Setup rollout only: hiding the catalog does not revoke existing connections. */
export const MEMORY_CONNECTOR_IDS = ["mem0", "zep", "supermemory", "cognee", "honcho"] as const;
export type MemoryConnectorId = (typeof MEMORY_CONNECTOR_IDS)[number];
export function isMemoryConnectorId(value: unknown): value is MemoryConnectorId {
  return typeof value === "string" && (MEMORY_CONNECTOR_IDS as readonly string[]).includes(value);
}
