import type { Tool, ToolRegistry } from "./types.js";

/**
 * Create an in-memory tool registry.
 *
 * The registry stores tools by name and provides O(1) lookup.
 * It is not thread-safe by design — the host manages concurrency.
 */
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>();

  return {
    register(tool: Tool): void {
      tools.set(tool.name, tool);
    },

    unregister(name: string): void {
      tools.delete(name);
    },

    get(name: string): Tool | undefined {
      return tools.get(name);
    },

    list(): Tool[] {
      return Array.from(tools.values());
    },

    has(name: string): boolean {
      return tools.has(name);
    },

    size(): number {
      return tools.size;
    },
  };
}
