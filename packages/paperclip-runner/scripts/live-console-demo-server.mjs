import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  CodexAppServerDriver,
  LiveConsoleDemoServer,
} from "../dist/index.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const host = option("--host") ?? "127.0.0.1";
const parsedPort = Number.parseInt(option("--port") ?? "4174", 10);
if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
  throw new Error("--port must be an integer from 0 to 65535");
}
const requestedDirectory = option("--working-directory");
const workingDirectory = requestedDirectory === undefined
  ? await mkdtemp(resolve(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "live-console-demo-"))
  : resolve(requestedDirectory);

const server = new LiveConsoleDemoServer({
  host,
  port: parsedPort,
  workingDirectory,
  driverFactory: (taskEnvelope) => new CodexAppServerDriver({
    taskEnvelope,
    onDiagnostic: (message) => process.stderr.write(`[liveConsole] ${message}\n`),
  }),
});

const address = await server.start();
process.stdout.write(`${JSON.stringify({
  schema: "paperclip.runner.live-console.server.v1",
  ...address,
  workingDirectory,
  providerAuthentication: "server-side",
  credentialsExposed: false,
})}\n`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
}

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
