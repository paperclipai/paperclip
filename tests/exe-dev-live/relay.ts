/** Optional persistent WSS relay for paid campaigns that exceed quick-tunnel limits.
 * Expose this loopback listener through an operator-owned TLS/SSH relay. */
import { createRunnerWssRelay } from "../runner-e2e/runner-wss-relay.js";
const registry = process.env.PAPERCLIP_E2E_RUNNER_RELAY_REGISTRY;
if (!registry) throw new Error("PAPERCLIP_E2E_RUNNER_RELAY_REGISTRY is required");
const port = Number(process.env.PAPERCLIP_E2E_RUNNER_RELAY_PORT ?? 35000);
const server = createRunnerWssRelay(registry);
server.listen(port, "127.0.0.1", () => console.log(`Runner-only relay on 127.0.0.1:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
