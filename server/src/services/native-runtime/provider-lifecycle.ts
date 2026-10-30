import { cursorLifecycleAdapter } from "./providers/cursor-lifecycle.js";

export type LifecycleRecord = Record<string, any>;

/** Provider interpretation only. The controller independently verifies the
 * committed event order, scope, delivery, tool lifecycle and receipt hashes. */
export interface NativeProviderLifecycleAdapter {
  planWait: {
    admits(provider: LifecycleRecord, history: { committed: boolean; legacy: boolean }): boolean;
    isRequest(request: LifecycleRecord): boolean;
    acceptedRevision(questionSet: LifecycleRecord, response: LifecycleRecord): string | null;
    allowsLegacyUnboundTool(provider: LifecycleRecord): boolean;
  };
  isPermissionRequest(request: LifecycleRecord): boolean;
}

const acpxAdapters: Readonly<Record<string, NativeProviderLifecycleAdapter | undefined>> = {
  cursor: cursorLifecycleAdapter,
};

export function nativeProviderLifecycle(provider: LifecycleRecord): NativeProviderLifecycleAdapter | undefined {
  if (provider.kind !== "acpx" || typeof provider.agent !== "string") return undefined;
  return Object.hasOwn(acpxAdapters, provider.agent) ? acpxAdapters[provider.agent] : undefined;
}
