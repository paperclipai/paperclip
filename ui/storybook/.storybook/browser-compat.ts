import { randomUuid } from "../../src/lib/random-uuid";

// Story fixtures and third-party components may call this secure-context-only
// API. Keep HTTP LAN/tailnet previews working with the same cryptographic bytes.
if (typeof globalThis.crypto.randomUUID !== "function") {
  globalThis.crypto.randomUUID = randomUuid;
}
