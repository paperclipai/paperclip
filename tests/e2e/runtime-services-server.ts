import net from "node:net";
import path from "node:path";
import { onboard } from "../../cli/src/commands/onboard.js";
import { runCommand } from "../../cli/src/commands/run.js";
import { readConfig, writeConfig } from "../../cli/src/config/store.js";

const home = process.env.PAPERCLIP_HOME;
const configPath = process.env.PAPERCLIP_CONFIG;
if (process.env.NODE_ENV !== "test" || process.env.PAPERCLIP_INSTANCE_ID !== "playwright-e2e"
  || !home || !path.basename(home).startsWith("paperclip-e2e-home-")
  || configPath !== path.join(home, "instances", "playwright-e2e", "config.json")) {
  throw new Error("Service acceptance must use its dedicated throwaway instance");
}

const authenticated = process.env.PAPERCLIP_DEPLOYMENT_MODE === "authenticated";
// Quickstart deliberately forces local-trusted defaults. Seed its explicit
// loopback preset, then configure authentication only in this isolated fixture.
await onboard({ config: configPath, yes: true, invokedByRun: true, installService: false, ...(authenticated ? { bind: "loopback" as const } : {}) });
const config = readConfig(configPath);
if (!config || config.database.mode !== "embedded-postgres") throw new Error("Expected the isolated embedded database");
if (authenticated) {
  const origin = process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL;
  if (origin !== `http://127.0.0.1:${process.env.PORT}`) throw new Error("Authenticated acceptance must stay on its loopback origin");
  config.server.deploymentMode = "authenticated";
  config.server.exposure = "private";
  config.auth = { ...config.auth, baseUrlMode: "explicit", publicBaseUrl: origin };
}
// Other worktrees also run browser tests on this host. Pick an ephemeral port
// instead of racing every bootstrap through the default 54329 fallback range.
const reservation = net.createServer();
await new Promise<void>((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(0, resolve);
});
try {
  config.database.embeddedPostgresPort = (reservation.address() as net.AddressInfo).port;
  writeConfig(config, configPath);
} finally {
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
}
await runCommand({ config: configPath, yes: true, repair: true });
