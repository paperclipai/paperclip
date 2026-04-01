// Shim for @paperclipai/plugin-sdk/ui — delegates to the mock bridge on globalThis.
// The dev harness (index.html) registers mock implementations on
// globalThis.__paperclipPluginBridge__.sdkUi before this module loads.

function getBridge() {
  return globalThis.__paperclipPluginBridge__?.sdkUi;
}

export function usePluginData(key, params) {
  return getBridge().usePluginData(key, params);
}

export function usePluginAction(key) {
  return getBridge().usePluginAction(key);
}

export function useHostContext() {
  return getBridge().useHostContext();
}

export function usePluginStream(channel, options) {
  return getBridge().usePluginStream(channel, options);
}

export function usePluginToast() {
  return getBridge().usePluginToast();
}
