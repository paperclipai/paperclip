/**
 * `@paperclipai/credential-broker-builtin` — default credential broker plugin
 * for Paperclip.
 *
 * Importing this module's side-effect entry from server startup
 * (`@paperclipai/credential-broker-builtin/register`) calls
 * `registerCredentialBroker()` so the server's broker registry resolves to
 * the built-in implementation. Importing from this entrypoint without the
 * /register subpath does not self-register — callers can construct
 * `createBuiltinBroker` directly for tests.
 */

export { createBuiltinBroker, registerBuiltinCredentialBroker } from "./broker.js";
export type { BuiltinBroker, BuiltinBrokerOptions } from "./broker.js";
export { createSessionStore } from "./session-store.js";
export type { SessionStore, BrokerSession, HostRule } from "./session-store.js";
export { createSessionCa } from "./ca.js";
export type { SessionCa } from "./ca.js";
export { createProxyListener } from "./proxy-listener.js";
export type { ProxyListener, ProxyLogEntry, ProxyLogger } from "./proxy-listener.js";

export const PACKAGE_NAME = "@paperclipai/credential-broker-builtin";
