#!/usr/bin/env node

import { createClaudeSdkServer, readBearerTokenFromFile } from "./index.js";

function printHelp() {
  process.stdout.write(`paperclip-claude-sdk-server

Usage:
  paperclip-claude-sdk-server --listen ws://127.0.0.1:4400 [--bearer-token TOKEN | --token-file PATH]

Options:
  --listen        WebSocket listen URL. Must use ws://.
  --bearer-token  Optional bearer token required as Authorization: Bearer <token>.
  --token-file    Read the bearer token from a file.
  --help          Show this help text.
`);
}

type CliOptions = {
  listenUrl: string;
  bearerToken: string | null;
};

async function parseArgs(argv: string[]): Promise<CliOptions> {
  let listenUrl = "ws://127.0.0.1:4400";
  let bearerToken: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--listen") {
      listenUrl = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--bearer-token") {
      bearerToken = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--token-file") {
      const pathname = argv[i + 1] ?? "";
      i += 1;
      bearerToken = await readBearerTokenFromFile(pathname);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { listenUrl, bearerToken };
}

async function main() {
  const options = await parseArgs(process.argv.slice(2));
  const bridge = createClaudeSdkServer({
    listenUrl: options.listenUrl,
    bearerToken: options.bearerToken,
  });
  const listening = await bridge.listen();
  process.stdout.write(`[paperclip-claude-sdk-server] listening on ${listening.url}\n`);

  const shutdown = async () => {
    await bridge.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
