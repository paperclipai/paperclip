import type { PluginToolDispatcher } from "./plugin-tool-dispatcher.js";

let currentPluginToolDispatcher: PluginToolDispatcher | null = null;

export function setCurrentPluginToolDispatcher(dispatcher: PluginToolDispatcher): void {
  currentPluginToolDispatcher = dispatcher;
}

export function getCurrentPluginToolDispatcher(): PluginToolDispatcher | null {
  return currentPluginToolDispatcher;
}
