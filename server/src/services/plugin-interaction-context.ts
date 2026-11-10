import { AsyncLocalStorage } from "node:async_hooks";

export interface PluginInteractionOrigin {
  companyId: string;
  agentId: string;
  runId?: string | null;
}

const origins = new AsyncLocalStorage<Readonly<PluginInteractionOrigin> | undefined>();

export function withPluginInteractionOrigin<T>(origin: PluginInteractionOrigin | undefined, fn: () => T): T {
  return origins.run(origin ? Object.freeze({ ...origin }) : undefined, fn);
}

export function currentPluginInteractionOrigin(): Readonly<PluginInteractionOrigin> | undefined {
  return origins.getStore();
}
