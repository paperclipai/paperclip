import type { PluginToolDispatcher } from "../plugin-tool-dispatcher.js";
import type { Db } from "@paperclipai/db";
import type {
  BuilderTool,
  BuilderToolRunContext,
  BuilderToolRunResult,
} from "./types.js";

/**
 * Plugin → Builder bridge.
 *
 * Plugin tools that declare `surfaces: ["builder"]` (or similar) are surfaced
 * in the Builder tool catalog. The bridge is registered at server startup
 * (see `app.ts`) by passing the live `PluginToolDispatcher` to
 * `setBuilderPluginBridge()`.
 *
 * The bridge is intentionally read-through: it queries the dispatcher every
 * time the catalog is requested so a plugin install / uninstall is reflected
 * immediately without restart.
 *
 * Security note: plugin tools are dispatched directly into the plugin worker
 * — they do **not** go through the `builder_proposals` lifecycle, because
 * the host doesn't know the semantic shape of arbitrary plugin actions.
 * Plugin authors that need governed, board-approved mutations should expose
 * those tools on the **agent** surface and rely on the existing Approvals
 * flow there. Builder intentionally hides plugin tools that declare
 * `requiresApproval`, because the builder runtime cannot convert arbitrary
 * plugin side effects into native `builder_proposals`.
 */

let _dispatcher: PluginToolDispatcher | null = null;

export function setBuilderPluginBridge(dispatcher: PluginToolDispatcher | null): void {
  _dispatcher = dispatcher;
}

/** Returns plugin-contributed builder tools. Empty when no dispatcher is wired. */
export function getPluginBuilderTools(_db: Db): BuilderTool[] {
  if (!_dispatcher) return [];
  const registry = _dispatcher.getRegistry();
  const tools: BuilderTool[] = [];

  for (const tool of registry.listTools()) {
    if (!tool.surfaces?.includes("builder")) continue;
    if (tool.requiresApproval) continue;

    const dispatcher = _dispatcher;
    tools.push({
      name: tool.name,
      description: tool.description,
      parametersSchema: tool.parametersSchema,
      requiresApproval: tool.requiresApproval,
      capability: `plugin.${tool.pluginId}`,
      source: `plugin.${tool.pluginId}`,
      async run(params: Record<string, unknown>, ctx: BuilderToolRunContext): Promise<BuilderToolRunResult> {
        try {
          const latest = dispatcher.getRegistry().getTool(tool.namespacedName);
          if (latest?.requiresApproval) {
            return {
              ok: false,
              error:
                "Plugin builder tools that require approval cannot run directly. Expose them through the agent surface or remove requiresApproval.",
            };
          }

          // Dispatch into the plugin worker. We pass the actor/company in
          // the runContext so plugins can scope their behaviour. Plugin
          // tool errors come back as failed `result`s, not thrown.
          const result = await dispatcher.executeTool(
            tool.namespacedName,
            params,
            {
              companyId: ctx.companyId,
              actorType: "user",
              actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
              actorAgentId: ctx.actor.type === "agent" ? ctx.actor.id : null,
              source: "builder",
              sessionId: ctx.sessionId,
            } as unknown as Parameters<typeof dispatcher.executeTool>[2],
          );
          if (result.result.error) {
            return { ok: false, error: result.result.error };
          }
          return {
            ok: true,
            result: result.result.data ?? result.result.content ?? null,
          };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : "Plugin tool execution failed",
          };
        }
      },
    });
  }

  return tools;
}
