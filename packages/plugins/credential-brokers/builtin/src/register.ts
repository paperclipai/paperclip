/**
 * Side-effect entry. Importing this module calls
 * `registerCredentialBroker()` from the SDK so the server picks up the
 * built-in broker on startup.
 *
 * Usage in the server's bootstrap path:
 *
 *   import "@paperclipai/credential-broker-builtin/register";
 *
 * For unit tests that want a clean registry, import from the package
 * root and construct `createBuiltinBroker` directly.
 */

import { registerCredentialBroker } from "@paperclipai/plugin-sdk";

import { registerBuiltinCredentialBroker } from "./broker.js";

registerBuiltinCredentialBroker(registerCredentialBroker);
