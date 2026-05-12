const R = globalThis.__paperclipPluginBridge__?.react;
function applyKey(props, key) {
  if (key === undefined) return props ?? {};
  return { ...(props ?? {}), key };
}
export const jsx = (type, props, key) => R.createElement(type, applyKey(props, key));
export const jsxs = (type, props, key) => R.createElement(type, applyKey(props, key));
export const Fragment = R.Fragment;
