type PluginBridgeRegistry = {
  react?: {
    createElement?: (type: unknown, props?: Record<string, unknown> | null) => unknown;
  } | null;
  sdkUi?: Record<string, unknown> | null;
};

type GlobalBridge = typeof globalThis & {
  __paperclipPluginBridge__?: PluginBridgeRegistry;
};

function getBridgeRegistry(): PluginBridgeRegistry | undefined {
  return (globalThis as GlobalBridge).__paperclipPluginBridge__;
}

function missingBridgeValueError(name: string): Error {
  return new Error(
    `Paperclip plugin UI runtime is not initialized for "${name}". ` +
      'Ensure the host loaded the plugin bridge before rendering this UI module.',
  );
}

export function getSdkUiRuntimeValue<T>(name: string): T {
  const value = getBridgeRegistry()?.sdkUi?.[name];
  if (value === undefined) {
    throw missingBridgeValueError(name);
  }
  return value as T;
}

export function renderSdkUiComponent<TProps>(
  name: string,
  props: TProps,
): unknown {
  const registry = getBridgeRegistry();
  const component = registry?.sdkUi?.[name];
  if (component === undefined) {
    throw missingBridgeValueError(name);
  }

  const createElement = registry?.react?.createElement;
  if (typeof createElement === "function") {
    return createElement(component, props as Record<string, unknown>);
  }

  if (typeof component === "function") {
    return component(props);
  }

  throw new Error(`Paperclip plugin UI component "${name}" is not callable`);
}
