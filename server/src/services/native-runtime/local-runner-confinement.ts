import { resolveRunnerConfinementMode, type RunnerConfinementPolicy } from "@paperclipai/paperclip-runner/live";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";

let embeddedDatabasePort: number | null = null;

/** Records the embedded database port, which confined local sessions may not reach. */
export function setLocalRunnerConfinementDatabasePort(port: number | null) {
  embeddedDatabasePort = port;
}

/**
 * The confinement applied to local runnerd launches. Companies on one instance
 * share the server's operating-system user, so each local session is kept to
 * its own state. `PAPERCLIP_LOCAL_AGENT_CONFINEMENT` selects `auto` (default),
 * `required` or `off`.
 */
export function localRunnerConfinementPolicy(companyId: string, env: NodeJS.ProcessEnv = process.env): RunnerConfinementPolicy {
  return {
    mode: resolveRunnerConfinementMode(env),
    instanceRoot: resolvePaperclipInstanceRoot(),
    companyId,
    deniedLoopbackPorts: embeddedDatabasePort === null ? [] : [embeddedDatabasePort],
  };
}
