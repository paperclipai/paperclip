import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DockerCommandError, POSTGRES_IMAGE, POSTGRES_IMAGE_ID, POSTGRES_VERSION, type DockerDatabaseReceipt, type DockerRun } from "../docker-postgres.js";
import { ownedClusterMatches, ownedRestoreTarget, prepareOwnedDockerDatabase } from "./privileged-docker-database.js";
const roots: string[] = [];
beforeEach(() => { vi.stubEnv("DOCKER_HOST", ""); vi.stubEnv("DOCKER_CONTEXT", ""); });
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
// These are deterministic control-admission tests, never a simulated eval pass.
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-runner-e2e-"))); roots.push(root);
  await chmod(root, 0o700);
  const directory = path.join(root, "docker-postgres-private"); await mkdir(directory, { mode: 0o700 });
  const nonce = "1".repeat(32), password = "2".repeat(64), configFile = path.join(root, "config.json"), filename = path.join(directory, "receipt.json");
  const receipt: DockerDatabaseReceipt = {
    schemaVersion: 1, lane: "owned-docker-postgres", temporaryRoot: root, nonce,
    engine: { context: "offline", endpoint: "unix:///offline.sock", engineId: "owned-engine", operatingSystem: "offline Linux" },
    containerId: "3".repeat(64), containerName: `paperclip-e2e-pg-${nonce}`, volumeName: `paperclip-e2e-pg-data-${nonce}`,
    image: POSTGRES_IMAGE, imageId: POSTGRES_IMAGE_ID, imageVersion: POSTGRES_VERSION, username: "owned_user", database: "owned_db",
    connectionString: `postgresql://owned_user:${password}@127.0.0.1:55432/owned_db`, port: 55432, status: "ready", artifactVerified: true,
    startedAt: "2026-10-27T00:00:00Z", cluster: { version: "18.6 (offline control)", username: "owned_user", database: "owned_db", systemIdentifier: "12345" },
  };
  await writeFile(filename, JSON.stringify(receipt), { mode: 0o600 });
  await writeFile(path.join(directory, "password"), password, { mode: 0o600 });
  await writeFile(configFile, JSON.stringify({ database: { mode: "postgres", connectionString: receipt.connectionString } }), { mode: 0o600 });
  const labels = { "ai.paperclip.runner-e2e.kind": "postgres", "ai.paperclip.runner-e2e.nonce": nonce,
    "ai.paperclip.runner-e2e.root": createHash("sha256").update(root).digest("hex"), "ai.paperclip.runner-e2e.uid": String(process.getuid?.()) };
  const container = { Id: receipt.containerId, Name: `/${receipt.containerName}`, Image: POSTGRES_IMAGE_ID,
    Config: { Image: POSTGRES_IMAGE, Labels: labels, Env: ["POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password", "POSTGRES_USER=owned_user", "POSTGRES_DB=owned_db"] },
    HostConfig: { Privileged: false, NetworkMode: "bridge", PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }] } },
    Mounts: [{ Type: "volume", Name: receipt.volumeName, Destination: "/var/lib/postgresql", RW: true },
      { Type: "bind", Source: path.join(directory, "password"), Destination: "/run/secrets/postgres-password", RW: false }],
    State: { Running: true }, NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }] } } };
  const state = { engine: "owned-engine", container, volume: { Name: receipt.volumeName, Driver: "local", Scope: "local", Options: {}, Labels: { ...labels } },
    cluster: { ...receipt.cluster! }, calls: [] as string[][], loseStopAck: false };
  const run: DockerRun = async args => {
    state.calls.push(args); const cmd = args[0] === "--context" ? args.slice(2) : args;
    if (cmd.join() === "context,show") return "offline";
    if (cmd[0] === "context") return JSON.stringify([{ Endpoints: { docker: { Host: receipt.engine.endpoint } } }]);
    if (cmd[0] === "info") return JSON.stringify({ id: state.engine, os: "linux", operatingSystem: receipt.engine.operatingSystem });
    if (cmd[0] === "inspect") return JSON.stringify([state.container]);
    if (cmd[0] === "volume" && cmd[1] === "inspect") return JSON.stringify([state.volume]);
    if (cmd[0] === "exec") return JSON.stringify(state.cluster);
    if (cmd[0] === "stop") { state.container.State.Running = false; if (state.loseStopAck) throw new DockerCommandError({ args, stdout: "", stderr: "offline lost ACK", exitCode: null, signal: "SIGTERM" }); return receipt.containerId!; }
    if (cmd[0] === "start") { state.container.State.Running = true; return receipt.containerId!; }
    throw new Error("Unexpected control operation");
  };
  return { root, filename, configFile, receipt, state, run };
}
it("stops and recovers only the same fully qualified owned cluster, without command credentials", async () => {
  const f = await fixture(), control = await prepareOwnedDockerDatabase(f.root, f.configFile, f.run);
  await control.stop(); expect(f.state.container.State.Running).toBe(false);
  await control.recover(); expect(f.state.container.State.Running).toBe(true);
  expect(f.state.calls.filter(args => args.includes("stop") || args.includes("start")).map(args => args.at(-1))).toEqual([f.receipt.containerId, f.receipt.containerId]);
  expect(JSON.stringify(f.state.calls)).not.toContain(new URL(f.receipt.connectionString!).password);
  expect(JSON.stringify(control.proof)).not.toContain(f.receipt.connectionString);
});
it("recovers after a real stop with lost acknowledgment, preserving the original identity", async () => {
  const f = await fixture(), control = await prepareOwnedDockerDatabase(f.root, f.configFile, f.run); f.state.loseStopAck = true;
  await expect(control.stop()).rejects.toThrow(); await control.recover(); expect(f.state.container.State.Running).toBe(true);
});
it("refuses changed engine/container/volume/cluster before any stop", async () => {
  for (const kind of ["engine", "container", "volume", "cluster"] as const) {
    const f = await fixture(), control = await prepareOwnedDockerDatabase(f.root, f.configFile, f.run);
    if (kind === "engine") f.state.engine = "foreign";
    if (kind === "container") f.state.container.Id = "4".repeat(64);
    if (kind === "volume") f.state.volume.Labels["ai.paperclip.runner-e2e.uid"] = "foreign";
    if (kind === "cluster") f.state.cluster.systemIdentifier = "99999";
    await expect(control.stop()).rejects.toThrow(); expect(f.state.calls.some(args => args.includes("stop"))).toBe(false);
  }
});
it("refuses altered receipt/config or nonprivate files and never starts a changed stopped target", async () => {
  for (const kind of ["receipt", "config", "permissions", "root", "password", "stopped"] as const) {
    const f = await fixture(), control = await prepareOwnedDockerDatabase(f.root, f.configFile, f.run);
    if (kind === "receipt") await writeFile(f.filename, (await readFile(f.filename, "utf8")) + " ");
    if (kind === "config") await writeFile(f.configFile, JSON.stringify({ database: { mode: "postgres", connectionString: "postgresql://foreign" } }));
    if (kind === "permissions") await chmod(f.filename, 0o644);
    if (kind === "root") await chmod(f.root, 0o755);
    if (kind === "password") await writeFile(path.join(f.root, "docker-postgres-private", "password"), "foreign");
    if (kind === "stopped") { await control.stop(); f.state.container.Id = "4".repeat(64); await expect(control.recover()).rejects.toThrow(); }
    else await expect(control.stop()).rejects.toThrow();
    expect(f.state.calls.some(args => args.includes("start"))).toBe(false);
  }
});
it("requires exact source config and generated separate restoration target", async () => {
  const f = await fixture(); await writeFile(f.configFile, JSON.stringify({ database: { mode: "postgres", connectionString: "postgresql://foreign" } }));
  await expect(prepareOwnedDockerDatabase(f.root, f.configFile, f.run)).rejects.toThrow("exact owned");
  const nonce = "case-nonce", name = `catalog_restore_${createHash("sha256").update(nonce).digest("hex").slice(0, 24)}`;
  expect(ownedRestoreTarget(name, "owned_db", nonce)).toBe(true);
  expect(ownedRestoreTarget(name, name, nonce)).toBe(false); expect(ownedRestoreTarget("production", "owned_db", nonce)).toBe(false);
  expect(ownedClusterMatches(f.receipt.cluster, { ...f.receipt.cluster, database: "other" })).toBe(false);
  expect(ownedClusterMatches(f.receipt.cluster, { ...f.receipt.cluster, version: "19.0" })).toBe(false);
});
