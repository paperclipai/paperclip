import type { QueryClient } from "@tanstack/react-query";

const unverifiedSessions = new WeakSet<QueryClient>();

export function markCachedSession(client: QueryClient) {
  unverifiedSessions.add(client);
}

export function verifyCachedSession(client: QueryClient) {
  unverifiedSessions.delete(client);
}

export function hasUnverifiedSession(client: QueryClient): boolean {
  return unverifiedSessions.has(client);
}
