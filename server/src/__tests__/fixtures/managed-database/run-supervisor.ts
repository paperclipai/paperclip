// Runs a managed database supervisor in its own process so tests can kill it
// (and its PostgreSQL child) abruptly, like a container interrupt.
import { createControlServer, listenUnix } from "../../../managed-database/control-server.js";
import { resolveEngineBinaries } from "../../../managed-database/engine.js";
import { readRelease } from "../../../managed-database/main.js";
import { resolvePgClientTools } from "../../../managed-database/snapshots.js";
import { ManagedDatabaseSupervisor } from "../../../managed-database/supervisor.js";

const options = JSON.parse(process.env.MDB_RUNNER_OPTIONS ?? "{}");
const engine = await resolveEngineBinaries();
const supervisor = new ManagedDatabaseSupervisor({
  config: options.config,
  controlKey: Buffer.from(options.controlKey, "base64"),
  env: {},
  engine,
  pgTools: await resolvePgClientTools(engine.major),
  release: await readRelease(),
  dbIdentity: null,
  appIdentity: null,
  pgPort: options.pgPort,
  deviceOf: (target: string) => (target === "/" ? 1 : 2),
  logger: { info: () => {}, warn: () => {}, error: (fields, message) => process.stderr.write(`${message} ${JSON.stringify(fields)}\n`) },
});
await supervisor.start();
const server = createControlServer(supervisor, () => !supervisor.appRunning);
await listenUnix(server, supervisor.layout.controlSocket);
process.stdout.write(`READY ${supervisor.enginePid()}\n`);
