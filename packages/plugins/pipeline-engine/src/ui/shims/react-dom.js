const RD = globalThis.__paperclipPluginBridge__?.reactDom;
export default RD;
export const {
  createPortal,
  flushSync,
  createRoot,
  hydrateRoot,
} = RD ?? {};
