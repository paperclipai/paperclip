import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  assertOwnedContainer, assertOwnedVolume, currentDockerEngine, readDockerDatabaseReceipt,
  runDocker, DockerCommandError, publicDockerDatabaseIdentity, type DockerDatabaseReceipt, type DockerRun,
} from "../docker-postgres.js";

const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
export function ownedClusterMatches(expected: DockerDatabaseReceipt["cluster"], actual: unknown) {
  const value = actual as DockerDatabaseReceipt["cluster"];
  return !!expected && !!value && /^18\.6(?:\s|$)/.test(value.version)
    && /^[0-9]+$/.test(value.systemIdentifier) && value.systemIdentifier === expected.systemIdentifier
    && value.version === expected.version && value.username === expected.username && value.database === expected.database;
}
export function ownedRestoreTarget(name: string, sourceDatabase: string, nonce: string) {
  return name === `catalog_restore_${digest(nonce).slice(0, 24)}` && name !== sourceDatabase;
}

/** Finite operator control of the launcher's existing cluster. No Docker client,
 * receipt, password or control callback is passed to the native agent. */
export async function prepareOwnedDockerDatabase(root: string, configFile: string, run: DockerRun = runDocker) {
  const filename = path.join(root, "docker-postgres-private", "receipt.json");
  const initial = await readDockerDatabaseReceipt(filename, root, run);
  if (!initial.artifactVerified || !initial.cluster) throw new Error("Owned Docker artifact/cluster qualification is missing");
  const connection = initial.connectionString!;
  const configBytes = await readFile(configFile, "utf8");
  const config = JSON.parse(configBytes);
  if (config.database?.mode !== "postgres" || config.database.connectionString !== connection)
    throw new Error("Current database config does not select the exact owned Docker cluster");
  const receiptDigest = digest(await readFile(filename, "utf8"));
  const configDigest = digest(configBytes);
  async function privateFile(file: string, exactMode?: number) {
    const entry = await lstat(file);
    if (await realpath(file) !== file || !entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.()
      || exactMode !== undefined && (entry.mode & 0o777) !== exactMode)
      throw new Error("Owned database private file identity changed");
  }
  async function verify(running?: boolean) {
    const rootEntry = await lstat(root), directory = path.dirname(filename), dirEntry = await lstat(directory);
    if (await realpath(root) !== root || !rootEntry.isDirectory() || rootEntry.uid !== process.getuid?.() || rootEntry.mode & 0o077
      || !path.basename(root).startsWith("paperclip-runner-e2e-") || !configFile.startsWith(root + path.sep)
      || await realpath(directory) !== directory || !dirEntry.isDirectory() || dirEntry.uid !== process.getuid?.() || dirEntry.mode & 0o077)
      throw new Error("Owned Docker attempt root changed");
    await privateFile(filename, 0o600); await privateFile(configFile);
    const passwordFile = path.join(directory, "password"); await privateFile(passwordFile, 0o600);
    if (digest(await readFile(filename, "utf8")) !== receiptDigest || digest(await readFile(configFile, "utf8")) !== configDigest
      || await readFile(passwordFile, "utf8") !== new URL(connection).password)
      throw new Error("Owned Docker receipt/config/password changed");
    const engine = await currentDockerEngine(run, { DOCKER_CONTEXT: initial.engine.context });
    if (JSON.stringify(engine) !== JSON.stringify(initial.engine)) throw new Error("Owned Docker engine changed");
    const container = JSON.parse(await run(["--context", initial.engine.context, "inspect", initial.containerId!]))[0];
    assertOwnedContainer(container, initial, running);
    assertOwnedVolume(JSON.parse(await run(["--context", initial.engine.context, "volume", "inspect", initial.volumeName]))[0], initial);
    return container.State.Running === true;
  }
  async function verifyCluster() {
    await verify(true);
    const actual = JSON.parse(await run(["--context", initial.engine.context, "exec", initial.containerId!, "psql", "-X", "-U", initial.username,
      "-d", initial.database, "-At", "-c", "SELECT json_build_object('version',current_setting('server_version'),'database',current_database(),'username',current_user,'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()))"]));
    if (!ownedClusterMatches(initial.cluster, actual)) throw new Error("Owned PostgreSQL cluster identity changed");
  }
  await verifyCluster();
  let stopRequested = false;
  return {
    connection, database: initial.database, verify: verifyCluster,
    proof: { ...publicDockerDatabaseIdentity(initial), ownerMatches: true, directoryWithinOwnedRoot: true },
    async stop() {
      await verifyCluster(); stopRequested = true;
      await run(["--context", initial.engine.context, "stop", "--time", "10", initial.containerId!], 30_000);
      await verify(false);
    },
    async recover() {
      if (!stopRequested) return;
      if (!await verify()) {
        // Revalidate immediately before the only supported state mutation.
        await verify(false);
        await run(["--context", initial.engine.context, "start", initial.containerId!], 20_000);
      }
      // pg_isready is bounded and does not imply cluster identity by itself.
      const deadline = Date.now() + 30_000;
      while (true) {
        try { await verifyCluster(); break; }
        catch (error) {
          if (!(error instanceof DockerCommandError) || Date.now() >= deadline) throw new Error("Exact owned Docker database recovery is unconfirmed; retain private supervisor evidence");
          await verify(true); // Changed custody is never retried as startup latency.
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
      stopRequested = false;
    },
  };
}
