import type { Db } from "@paperclipai/db";
import type { BuilderTool, BuilderToolRunContext, BuilderToolRunResult } from "./types.js";
import { buildCoreReadOnlyTools } from "./tools/core-read.js";
import { buildCoreMutationTools } from "./tools/core-mutation.js";
import { getPluginBuilderTools } from "./plugin-bridge.js";

/**
 * Builder tool registry.
 *
 * Two registration paths:
 *
 * 1. **Core tools** are computed lazily per-request from the Db handle (so
 *    they bind to whatever Drizzle client the request is using).
 * 2. **Extension tools** are registered once at module load time via
 *    `registerBuilderTool()`. This is the "rich edges" hook from
 *    `doc/PRODUCT.md` — platform modules (and, in Phase 3, plugins) can add
 *    Builder-visible tools without editing core.
 *
 * Tool *names* are namespaced by source: `core.list_agents`, plugin tools
 * become `plugin.<id>.<name>`. The runner exposes the namespaced name to the
 * model; this prevents name collisions when extensions are loaded.
 */

const _extensions = new Map<string, BuilderTool>();

function namespacedName(tool: BuilderTool): string {
  if (tool.source === "core") return `core.${tool.name}`;
  return `${tool.source}.${tool.name}`;
}

/**
 * Register an additional Builder tool from a platform module.
 *
 * Throws if a tool with the same namespaced name is already registered, so
 * accidental shadowing is loud rather than silent.
 */
export function registerBuilderTool(tool: BuilderTool): void {
  if (tool.source === "core") {
    throw new Error(
      "Core builder tools must be registered through buildCoreReadOnlyTools, not registerBuilderTool",
    );
  }
  const key = namespacedName(tool);
  if (_extensions.has(key)) {
    throw new Error(`Builder tool "${key}" is already registered`);
  }
  _extensions.set(key, tool);
}

/** Test-only helper. */
export function _resetBuilderToolExtensions(): void {
  _extensions.clear();
}

/**
 * Build the full tool catalog for a request, keyed by namespaced name.
 *
 * Core read-only tools are always included; extensions are appended in
 * registration order.
 */
export function getBuilderToolCatalog(db: Db): Map<string, BuilderTool> {
  const map = new Map<string, BuilderTool>();
  for (const tool of buildCoreReadOnlyTools(db)) {
    map.set(namespacedName(tool), tool);
  }
  for (const tool of buildCoreMutationTools()) {
    map.set(namespacedName(tool), tool);
  }
  for (const tool of getPluginBuilderTools(db)) {
    map.set(namespacedName(tool), tool);
  }
  for (const [key, tool] of _extensions) {
    map.set(key, tool);
  }
  return map;
}

/**
 * Look up a tool by either its namespaced name (`core.list_agents`) or its
 * bare name (`list_agents`) — the second is what well-behaved models will
 * emit when only one tool with that bare name is registered.
 */
export function resolveBuilderTool(
  catalog: Map<string, BuilderTool>,
  requestedName: string,
): BuilderTool | null {
  const direct = catalog.get(requestedName);
  if (direct) return direct;
  for (const tool of catalog.values()) {
    if (tool.name === requestedName) return tool;
  }
  return null;
}

/**
 * Invoke a tool with structured error handling — failures never throw past
 * this boundary (the runner needs a value to feed back to the model).
 */
export async function safeRunTool(
  tool: BuilderTool,
  params: Record<string, unknown>,
  ctx: BuilderToolRunContext,
): Promise<BuilderToolRunResult> {
  try {
    return await tool.run(params, ctx);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Tool execution failed",
    };
  }
}
