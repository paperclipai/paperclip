import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main() {
  const configPath = join(homedir(), ".paperclip", "document-opener.json");
  const config = loadConfig(configPath);

  if (!config) {
    console.error(`[document-opener] config missing or invalid at ${configPath}; server will reject all requests with 503`);
  }

  const port = config?.port ?? DEFAULT_PORT;
  const running = await createServer({ config, port });
  console.log(`[document-opener] listening on 127.0.0.1:${port} (roots: ${config?.roots.join(", ") ?? "<none>"})`);

  const shutdown = async (signal: string) => {
    console.log(`[document-opener] received ${signal}, shutting down`);
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[document-opener] fatal:", err);
  process.exit(1);
});
