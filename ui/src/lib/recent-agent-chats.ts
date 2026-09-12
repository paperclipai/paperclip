import { useCallback, useSyncExternalStore } from "react";
import type { Agent } from "@paperclipai/shared";
const eventName = "paperclip:recent-agent-chats";
const key = (company: string, user?: string | null) =>
  `paperclip.recentAgentChats:${company}:${user ?? "__local_board__"}`;
const memory = new Map<string, string>();
function read(storageKey: string): string {
  try {
    return (
      window.localStorage.getItem(storageKey) ?? memory.get(storageKey) ?? "[]"
    );
  } catch {
    return memory.get(storageKey) ?? "[]";
  }
}
export function parseRecentAgentChats(raw: string): string[] {
  try {
    const ids: unknown = JSON.parse(raw);
    return Array.isArray(ids)
      ? [
          ...new Set(ids.filter((id): id is string => typeof id === "string")),
        ].slice(0, 50)
      : [];
  } catch {
    return [];
  }
}
export function recordAgentChatVisit(
  company: string,
  user: string | null | undefined,
  agentId: string,
) {
  const storageKey = key(company, user);
  const value = JSON.stringify(
    [
      agentId,
      ...parseRecentAgentChats(read(storageKey)).filter((id) => id !== agentId),
    ].slice(0, 50),
  );
  memory.set(storageKey, value);
  try {
    window.localStorage.setItem(storageKey, value);
  } catch {
    /* In-tab navigation still works without storage. */
  }
  window.dispatchEvent(new Event(eventName));
}
function subscribe(callback: () => void) {
  window.addEventListener(eventName, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(eventName, callback);
    window.removeEventListener("storage", callback);
  };
}
export function useRecentAgentChats(company: string, user?: string | null) {
  const getSnapshot = useCallback(
    () => read(key(company, user)),
    [company, user],
  );
  return parseRecentAgentChats(
    useSyncExternalStore(subscribe, getSnapshot, () => "[]"),
  );
}
export function orderChatAgents<T extends Pick<Agent, "id" | "name">>(
  agents: T[],
  stars: string[],
  recent: string[],
) {
  return [
    ...agents
      .filter((agent) => stars.includes(agent.id))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    ...recent
      .filter((id) => !stars.includes(id))
      .flatMap((id) => agents.filter((agent) => agent.id === id))
      .slice(0, 4),
  ];
}
