import { resolve } from "node:path";

/** postmaster.pid records the actual listening port, which can differ from the
 * configured port after collision avoidance. Never reuse the configured port. */
export function embeddedPostgresOwnerPort(contents: string, dataDir: string, expectedPid: number): number {
  const [pid, directory, , portText] = contents.split("\n");
  const port = Number(portText);
  if (Number(pid) !== expectedPid || !directory || resolve(directory) !== resolve(dataDir) ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("The running embedded PostgreSQL identity does not match this instance. Startup stopped before connecting.");
  return port;
}
