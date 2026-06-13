/**
 * Server-side memory reader — re-exports the canonical implementation from
 * @paperclipai/adapter-claude-local to avoid duplicating ~130 lines of logic.
 *
 * The full implementation lives in:
 *   packages/adapters/claude-local/src/server/active-memory.ts
 */
export type { MemoryTrigger, MemoryEntry } from "@paperclipai/adapter-claude-local/server";
export { readAlwaysCheckMemories } from "@paperclipai/adapter-claude-local/server";
