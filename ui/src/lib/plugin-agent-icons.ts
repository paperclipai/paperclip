/**
 * Registry of plugin-registered agent icons.
 *
 * Built-in agent icons (`AGENT_ICON_NAMES`) are a closed set: the create/update
 * validator enforces a `z.enum`, and `AGENT_ICONS` in `./agent-icons.ts` maps
 * each name to a fixed lucide component with no per-agent override. A plugin
 * could previously only "repaint" one of those names via CSS (see the
 * customizations-by-nick `agent-monograms` tweak), which meant claiming a name
 * a real agent might legitimately want.
 *
 * This registry lets a plugin add an icon under its OWN namespaced id instead
 * — `plugin:<pluginId>:<iconKey>`, matching `PLUGIN_AGENT_ICON_NAME_RE` — so it
 * shows up as its own entry in the icon picker rather than overwriting a
 * built-in one. `getAgentIcon` in `./agent-icons.ts` checks here before falling
 * back to the default icon.
 */
import type { ComponentType } from "react";
import { isPluginAgentIconName } from "@paperclipai/shared";

export interface PluginAgentIconProps {
  className?: string;
}

export type PluginAgentIconComponent = ComponentType<PluginAgentIconProps>;

const registry = new Map<string, PluginAgentIconComponent>();

/**
 * Registers a custom agent icon. `id` must be `plugin:<pluginId>:<iconKey>`
 * (see `PLUGIN_AGENT_ICON_NAME_RE`) so icons from different plugins can never
 * collide with each other or with a built-in name.
 *
 * Exposed to plugin bundles as `registerAgentIcon` from
 * `@paperclipai/plugin-sdk/ui`. Call it once — e.g. from a `globalToolbarButton`
 * slot component, which the host mounts on every page.
 */
export function registerAgentIcon(id: string, component: PluginAgentIconComponent): void {
  if (!isPluginAgentIconName(id)) {
    throw new Error(
      `registerAgentIcon: "${id}" must look like "plugin:<pluginId>:<iconKey>" (see PLUGIN_AGENT_ICON_NAME_RE)`,
    );
  }
  registry.set(id, component);
}

export function getRegisteredAgentIcon(id: string): PluginAgentIconComponent | undefined {
  return registry.get(id);
}

export function listRegisteredAgentIcons(): ReadonlyArray<[string, PluginAgentIconComponent]> {
  return [...registry.entries()];
}
