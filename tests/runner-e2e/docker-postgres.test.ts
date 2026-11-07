import { publicDockerDatabaseIdentity, selectedPostgresArtifact, POSTGRES_ARTIFACT_ENV, POSTGRES_IMAGE_ID_ENV, POSTGRES_AMD64_IMAGE, POSTGRES_AMD64_IMAGE_IDS } from "./docker-postgres.js";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink, chmod } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertOwnedContainer, currentDockerEngine, DockerCommandError, databaseFingerprintIdentity, databaseIdentityMatches, dockerDatabaseLaunchState, dockerDatabaseSupervisorEnvironment, DOCKER_DATABASE_ENV, DATABASE_LANE_ENV, POSTGRES_IMAGE, POSTGRES_IMAGE_ID, POSTGRES_VERSION, selectedDatabaseLane, startOwnedDockerDatabase, type DockerRun } from "./docker-postgres.js";
import { prepareRunnerE2EServerConfig } from "./server-config.js";
import { assertRunnerDatabaseIsolation, assertEmbeddedDatabaseIsolation } from "./instance-isolation.js";
import { campaignDatabaseEvidenceEligible, type CampaignAttempt } from "./chat-campaign.js";
import { assertChatCatalogFingerprintLane, fingerprintChatDependencyClosure } from "./chat-catalog-fingerprint.js";
import { validateRetainedRunnerResult } from "./result-validation.js";
import { buildPaperclipServerEnvironment } from "./harness-env.js";
import { assertDockerCustodyMetadata } from "./docker-config-custody.js";
import { findSecretLeakInDirectory } from "./redaction.js";
import { createSanitizedCodexEnvironment } from "../../packages/paperclip-runner/src/drivers/codex/app-server-transport.js";
const roots: string[] = [];
beforeEach(() => { vi.stubEnv("DOCKER_HOST", ""); vi.stubEnv("DOCKER_CONTEXT", ""); });
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const p = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-runner-e2e-"))); roots.push(p); return p; }
function daemon() {
  const artifact = selectedPostgresArtifact();
  const state = { calls: [] as string[][], engine: "engine-one", operatingSystem: "Docker Desktop", endpoint: "unix:///private/offline-docker.sock", container: null as any, volume: null as any, loseVolumeAck: false, loseContainerAck: false, inspectionError: false, volumeInspectionError: false, badImage: false, failStart: false };
  const missing = (args: string[], name: string) => new DockerCommandError({ args, stdout: "[]", stderr: `Error: No such object: ${name}`, exitCode: 1, signal: null });
  const run: DockerRun = async args => {
    state.calls.push(args); const cmd = args[0] === "--context" ? args.slice(2) : args;
    if (cmd.join() === "context,show") return "offline-context";
    if (cmd[0] === "context") return JSON.stringify([{ Endpoints: { docker: { Host: state.endpoint } } }]);
    if (cmd[0] === "info") return JSON.stringify({ id: state.engine, os: "linux", operatingSystem: state.operatingSystem });
    if (cmd[0] === "image") return JSON.stringify([{ Id: state.badImage ? "wrong-image" : artifact.imageId, Os: "linux", Architecture: artifact.architecture, RepoDigests: [artifact.image], Config: { Env: [`PG_VERSION=${POSTGRES_VERSION}`] } }]);
    if (cmd[0] === "volume") {
      if (cmd[1] === "create") { const labels: Record<string, string> = {}; for (let i = 0; i < cmd.length; i++) if (cmd[i] === "--label") { const [key, value] = cmd[i + 1]!.split("="); labels[key!] = value!; }
        state.volume = { Name: cmd.at(-1), Driver: "local", Scope: "local", Options: null, Labels: labels };
        if (state.loseVolumeAck) throw new Error("lost volume ACK"); return state.volume.Name;
      }
      if (cmd[1] === "inspect") { if (state.volumeInspectionError) throw new Error("volume inspection unknown"); if (!state.volume) throw missing(args, cmd.at(-1)!); return JSON.stringify([state.volume]); }
      if (cmd[1] === "rm") { state.volume = null; return cmd.at(-1)!; }
    }
    if (cmd[0] === "create") {
      const labels: Record<string, string> = {}, env: string[] = [], mounts: any[] = [];
      for (let i = 0; i < cmd.length; i++) {
        if (cmd[i] === "--label") { const [k, v] = cmd[i + 1]!.split("="); labels[k!] = v!; }
        if (cmd[i] === "--env") env.push(cmd[i + 1]!);
        if (cmd[i] === "--mount") { const fields = Object.fromEntries(cmd[i + 1]!.split(",").map(p => p.split("="))); mounts.push({ Type: fields.type, ...(fields.type === "volume" ? { Name: fields.src } : { Source: fields.src }), Destination: fields.dst, RW: !cmd[i + 1]!.includes("readonly") }); }
      }
      state.container = { Id: "a".repeat(64), Name: `/${cmd[cmd.indexOf("--name") + 1]}`, Image: artifact.imageId, Config: { Image: artifact.image, Env: env, Labels: labels }, HostConfig: { Privileged: false, NetworkMode: "default", PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } }, Mounts: mounts, State: { Running: false }, NetworkSettings: { Ports: {} } };
      if (state.loseContainerAck) throw new Error("lost container ACK"); return state.container.Id;
    }
    if (cmd[0] === "inspect") { if (state.inspectionError) throw new Error("daemon inspection unavailable"); if (!state.container) throw missing(args, cmd.at(-1)!); return JSON.stringify([state.container]); }
    if (cmd[0] === "start") { if (state.failStart) throw new Error("real startup failure"); state.container.State.Running = true; state.container.NetworkSettings.Ports["5432/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "55432" }]; return cmd.at(-1)!; }
    if (cmd[0] === "stop") { state.container.State.Running = false; state.container.NetworkSettings.Ports = {}; return cmd.at(-1)!; }
    if (cmd[0] === "rm") { state.container = null; return cmd.at(-1)!; }
    if (cmd[0] === "logs") return "actual private fixture startup output";
    if (cmd[0] === "exec") {
      if (cmd.includes("pg_isready")) return "accepting connections";
      const user = state.container.Config.Env.find((v: string) => v.startsWith("POSTGRES_USER=")).split("=")[1], db = state.container.Config.Env.find((v: string) => v.startsWith("POSTGRES_DB=")).split("=")[1];
      return JSON.stringify({ version: "18.6 (offline fixture)", username: user, database: db, systemIdentifier: "123456789" });
    }
    throw new Error("Unexpected offline Docker operation");
  };
  return { state, run };
}
it("keeps embedded default and ambient URL scrubbing, refusing undeclared/unknown lanes", async () => {
  expect(selectedDatabaseLane({ DATABASE_URL: "postgres://unrelated" })).toBe("embedded-postgres");
  expect(buildPaperclipServerEnvironment({ DATABASE_URL: "postgres://unrelated" }).DATABASE_URL).toBeUndefined();
  expect(() => selectedDatabaseLane({ [DATABASE_LANE_ENV]: "ambient" })).toThrow();
  await expect(dockerDatabaseSupervisorEnvironment({ temporaryRoot: "/unowned", env: { [DOCKER_DATABASE_ENV]: "/unowned" } })).rejects.toThrow("Undeclared");
  await expect(dockerDatabaseSupervisorEnvironment({ temporaryRoot: "/unowned", env: { [DATABASE_LANE_ENV]: "owned-docker-postgres" } })).rejects.toThrow("missing");
});
it("binds exact image/engine/resources, strips admission data and removes only owned container+volume", async () => {
  const temp = await root(), { state, run } = daemon(), secrets: string[] = [];
  const owned = await startOwnedDockerDatabase({ temporaryRoot: temp, privateSecrets: secrets, run });
  expect(owned.receipt.status).toBe("ready"); expect(secrets).toHaveLength(2);
  expect(JSON.stringify(state.calls)).not.toContain(secrets[0]); expect(JSON.stringify(state.calls)).not.toContain(owned.receipt.connectionString);
  const supervisor = await dockerDatabaseSupervisorEnvironment({ temporaryRoot: temp, env: { [DATABASE_LANE_ENV]: "owned-docker-postgres", [DOCKER_DATABASE_ENV]: owned.filename }, run });
  expect(supervisor.source[DOCKER_DATABASE_ENV]).toBeUndefined(); expect(supervisor.source[DATABASE_LANE_ENV]).toBeUndefined();
  const configPath = path.join(temp, "paperclip-home", "instances", "fixture", "config.json");
  expect(await prepareRunnerE2EServerConfig({ temporaryRoot: temp, configPath, serverPort: 3100, dockerReceiptPath: owned.filename, dockerRun: run })).toBeNull();
  const config = JSON.parse(await readFile(configPath, "utf8")); expect(config.database.mode).toBe("postgres"); expect(config.database.connectionString).toBe(owned.receipt.connectionString);
  const key = config.secrets.localEncrypted.keyFilePath; await mkdir(path.dirname(key), { recursive: true }); await writeFile(key, "offline-key", { mode: 0o600 });
  await expect(assertRunnerDatabaseIsolation(configPath, temp, owned.filename, run)).resolves.toBeUndefined();
  const changed = structuredClone(config); changed.database.connectionString = "postgresql://foreign"; await writeFile(configPath, JSON.stringify(changed), { mode: 0o600 });
  await expect(assertRunnerDatabaseIsolation(configPath, temp, owned.filename, run)).rejects.toThrow("owned database lane");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await expect(assertEmbeddedDatabaseIsolation(configPath, temp)).rejects.toThrow("owned database lane");
  const mutated = structuredClone(state.container); mutated.Config.Labels["ai.paperclip.runner-e2e.nonce"] = "foreign"; expect(() => assertOwnedContainer(mutated, owned.receipt)).toThrow("ownership");
  await owned.close(); expect(state.container).toBeNull(); expect(state.volume).toBeNull(); expect(owned.receipt.status).toBe("removed");
  await expect(readFile(path.join(temp, "docker-postgres-private", "password"))).rejects.toThrow();
});
it("recovers a lost volume-create ACK through exact labels and verifies absence", async () => {
  const temp = await root(), { state, run } = daemon(); state.loseVolumeAck = true;
  await expect(startOwnedDockerDatabase({ temporaryRoot: temp, privateSecrets: [], run })).rejects.toThrow("startup failed");
  const receipt = JSON.parse(await readFile(path.join(temp, "docker-postgres-private", "receipt.json"), "utf8"));
  expect(receipt.volumeCreationAttempted).toBe(true); expect(receipt.primaryFailure).toContain("lost volume ACK"); expect(receipt.status).toBe("removed"); expect(state.volume).toBeNull();
});
it("recovers a lost container ACK but never labels unknown inspection as cleanup success", async () => {
  const temp = await root(), { state, run } = daemon(); state.loseContainerAck = true; state.inspectionError = true;
  await expect(startOwnedDockerDatabase({ temporaryRoot: temp, privateSecrets: [], run })).rejects.toThrow("cleanup is unconfirmed");
  const receipt = JSON.parse(await readFile(path.join(temp, "docker-postgres-private", "receipt.json"), "utf8"));
  expect(receipt.containerCreationAttempted).toBe(true); expect(receipt.primaryFailure).toContain("lost container ACK"); expect(receipt.status).toBe("cleanup-failed"); expect(state.container).not.toBeNull(); expect(state.volume).not.toBeNull();
  expect(state.calls.some(args => args.includes("rm"))).toBe(false);
});
it("cleans an owned recovered container after a lost ACK and preserves actual startup failure separately", async () => {
  const temp = await root(), { state, run } = daemon(); state.loseContainerAck = true;
  await expect(startOwnedDockerDatabase({ temporaryRoot: temp, privateSecrets: [], run })).rejects.toThrow("startup failed");
  const receipt = JSON.parse(await readFile(path.join(temp, "docker-postgres-private", "receipt.json"), "utf8"));
  expect(receipt.containerId).toBe("a".repeat(64)); expect(receipt.status).toBe("removed"); expect(state.container).toBeNull(); expect(state.volume).toBeNull();
});
it("refuses foreign ownership or context switches without signaling/removing resources", async () => {
  const temp = await root(), { state, run } = daemon(), owned = await startOwnedDockerDatabase({ temporaryRoot: temp, privateSecrets: [], run });
  state.engine = "another-engine"; const before = state.calls.length;
  await expect(owned.close()).rejects.toThrow("unconfirmed"); expect(owned.receipt.status).toBe("cleanup-failed");
  expect(state.calls.slice(before).some(args => args.includes("stop") || args.includes("rm"))).toBe(false);
});
it("rejects a remote context and wrong image before resource creation", async () => {
  const remote = daemon(); remote.state.endpoint = "tcp://remote.invalid:2375"; await expect(currentDockerEngine(remote.run, {})).rejects.toThrow("Unix socket");
  const temp = await root(), { state, run } = daemon(); state.badImage = true;
  await expect(startOwnedDockerDatabase({ temporaryRoot: temp, privateSecrets: [], run })).rejects.toThrow("startup failed");
  expect(state.calls.some(args => args.includes("create"))).toBe(false);
});

it("preserves a lost-volume-ACK resource when inspection is unknown", async () => {
  const temp = await root(), { state, run } = daemon(); state.loseVolumeAck = true; state.volumeInspectionError = true;
  await expect(startOwnedDockerDatabase({ temporaryRoot: temp, privateSecrets: [], run })).rejects.toThrow("cleanup is unconfirmed");
  const receipt = JSON.parse(await readFile(path.join(temp, "docker-postgres-private", "receipt.json"), "utf8"));
  expect(receipt.status).toBe("cleanup-failed"); expect(receipt.volumeCreationAttempted).toBe(true); expect(state.volume).not.toBeNull(); expect(state.calls.some(args => args.includes("rm"))).toBe(false);
});
it("refuses changed volume ownership without deletion", async () => {
  const temp = await root(), { state, run } = daemon(), owned = await startOwnedDockerDatabase({ temporaryRoot: temp, privateSecrets: [], run });
  state.volume.Labels["ai.paperclip.runner-e2e.nonce"] = "foreign";
  await expect(owned.close()).rejects.toThrow("volume absence is unconfirmed");
  expect(state.container).toBeNull(); expect(state.volume).not.toBeNull(); expect(owned.receipt.status).toBe("cleanup-failed");
});

it("launcher failure state never reaps Darwin IPC or drops uncertain Docker recovery without a returned handle", async () => {
  const temp = await root(), { state, run } = daemon(); state.loseContainerAck = true; state.inspectionError = true;
  let handle: Awaited<ReturnType<typeof startOwnedDockerDatabase>> | undefined;
  try { handle = await startOwnedDockerDatabase({ temporaryRoot: temp, privateSecrets: [], run }); } catch { /* Same undefined-handle path as launcher catch/finally. */ }
  expect(handle).toBeUndefined(); const finalization = await dockerDatabaseLaunchState("owned-docker-postgres", temp);
  expect(finalization.allowDarwinReap).toBe(false); expect(finalization.cleanupUnconfirmed).toBe(true); expect(finalization.identity?.lane).toBe("owned-docker-postgres"); expect(finalization.identity?.status).toBe("cleanup-failed");
  const noReceipt = await dockerDatabaseLaunchState("owned-docker-postgres", await root());
  expect(noReceipt.allowDarwinReap).toBe(false); expect(noReceipt.cleanupUnconfirmed).toBe(true); expect(noReceipt.identity?.status).toBe("startup-unconfirmed");
});

it("preserves old embedded result interpretation and rejects unverified or credential-bearing Docker proof", async () => {
  const legacy = { schema: "paperclip.runner-e2e.result/v1", executionId: "offline", attempt: 1, status: "failed", profileId: "offline", environmentId: "local", caseId: "offline", provider: null, model: null, runtimeMode: "none", startedAt: "2026-10-27T00:00:00Z", finishedAt: "2026-10-27T00:00:01Z", durationMs: 1000, cleanup: "passed" };
  const original = JSON.stringify(legacy); expect(() => validateRetainedRunnerResult(legacy)).not.toThrow(); expect(JSON.stringify(legacy)).toBe(original);
  const temp = await root(), { run } = daemon(), owned = await startOwnedDockerDatabase({ temporaryRoot: temp, privateSecrets: [], run }); await owned.close();
  const state = await dockerDatabaseLaunchState("owned-docker-postgres", temp), passed = { ...legacy, status: "passed", databaseIdentity: state.identity };
  expect(() => validateRetainedRunnerResult(passed)).not.toThrow();
  for (const change of [{ artifactVerified: false }, { containerId: null }, { status: "startup-unconfirmed" }, { image: "postgres@sha256:" + "b".repeat(64) }, { connectionString: "postgresql://credential-must-not-be-public" }]) {
    expect(() => validateRetainedRunnerResult({ ...passed, databaseIdentity: { ...state.identity, ...change } })).toThrow();
  }
});

it("fingerprints stable database lane/artifacts and rejects cross-lane retained proof", async () => {
  const temp = await root(), selected = { suiteId: "chat-features", flow: "agent_chat", environment: "local" };
  const embedded = assertChatCatalogFingerprintLane(selected, {}, []).database;
  const docker = assertChatCatalogFingerprintLane(selected, { [DATABASE_LANE_ENV]: "owned-docker-postgres" }, []).database;
  await writeFile(path.join(temp, "fixture.ts"), "export const noProductAction = true;");
  const fingerprint = (database: unknown) => fingerprintChatDependencyClosure({ root: temp, entries: ["fixture.ts"], selected: { ...selected, database } }).digest;
  expect(fingerprint(embedded)).not.toBe(fingerprint(docker)); expect(docker).toEqual(databaseFingerprintIdentity({ [DATABASE_LANE_ENV]: "owned-docker-postgres" }));
  expect(() => assertChatCatalogFingerprintLane({ ...selected, databaseLane: embedded }, { [DATABASE_LANE_ENV]: "owned-docker-postgres" }, [])).toThrow("differs");
  const { run } = daemon(), owned = await startOwnedDockerDatabase({ temporaryRoot: temp, privateSecrets: [], run }); await owned.close();
  const actual = (await dockerDatabaseLaunchState("owned-docker-postgres", temp)).identity!;
  expect(databaseIdentityMatches(docker, actual)).toBe(true); expect(databaseIdentityMatches(embedded, actual)).toBe(false); expect(databaseIdentityMatches(docker)).toBe(false);
  const relative = "tests/runner-e2e/results/owned/result.json"; await mkdir(path.dirname(path.join(temp, relative)), { recursive: true });
  await writeFile(path.join(temp, relative), JSON.stringify({ executionId: "owned", source: { sha: "a".repeat(40) }, databaseIdentity: actual }));
  const attempt = { executionId: "owned", sourceRevision: "a".repeat(40), evidencePaths: [relative], databaseLane: docker } as CampaignAttempt;
  expect(campaignDatabaseEvidenceEligible(attempt, temp)).toBe(true);
  expect(campaignDatabaseEvidenceEligible({ ...attempt, databaseLane: embedded }, temp)).toBe(false);
  expect(campaignDatabaseEvidenceEligible({ ...attempt, databaseLane: undefined }, temp)).toBe(false);
});

it("allows only exact Docker Desktop host translation with an owned canonical private password", async () => {
  const temp = await root(), { state, run } = daemon(), owned = await startOwnedDockerDatabase({ temporaryRoot: temp, privateSecrets: [], run });
  const password = path.join(temp, "docker-postgres-private", "password");
  const mount = state.container.Mounts.find((m: any) => m.Destination === "/run/secrets/postgres-password");
  mount.Source = `/host_mnt${password}`;
  expect(() => assertOwnedContainer(state.container, owned.receipt, true)).not.toThrow();
  const wrongRoot = structuredClone(state.container); wrongRoot.Mounts.find((m: any) => m.Destination === "/run/secrets/postgres-password").Source = `/host_mnt${password}-foreign`;
  expect(() => assertOwnedContainer(wrongRoot, owned.receipt)).toThrow("ownership");
  expect(() => assertOwnedContainer(state.container, { ...owned.receipt, engine: { ...owned.receipt.engine, operatingSystem: "Debian GNU/Linux" } })).toThrow("ownership");
  const writable = structuredClone(state.container); writable.Mounts.find((m: any) => m.Destination === "/run/secrets/postgres-password").RW = true;
  expect(() => assertOwnedContainer(writable, owned.receipt)).toThrow("ownership");
  const contents = await readFile(password); await rm(password); const target = path.join(temp, "other-password"); await writeFile(target, contents, { mode: 0o600 }); await symlink(target, password);
  expect(() => assertOwnedContainer(state.container, owned.receipt)).toThrow("ownership");
  await rm(password); await writeFile(password, contents, { mode: 0o600 });
  await owned.close(); expect(state.container).toBeNull(); expect(state.volume).toBeNull();
});

it("scans every raw config byte except one verified owned DSN field", async () => {
  const temp = await root(), { run } = daemon(), secrets: string[] = [];
  const owned = await startOwnedDockerDatabase({ temporaryRoot: temp, privateSecrets: secrets, run });
  const home = path.join(temp, "paperclip-home"), configPath = path.join(home, "instances", "runner-e2e-custody", "config.json");
  await prepareRunnerE2EServerConfig({ temporaryRoot: temp, configPath, serverPort: 3100, dockerReceiptPath: owned.filename, dockerRun: run });
  const options = { includeShapes: false, privateDockerDatabaseConfig: { temporaryRoot: temp, configPath, receiptPath: owned.filename, run } };
  const original = await readFile(configPath, "utf8");
  expect(await findSecretLeakInDirectory(home, secrets, options)).toBeNull();
  expect(await findSecretLeakInDirectory(home, secrets, { includeShapes: false })).not.toBeNull();
  for (const extra of [secrets[0], owned.receipt.connectionString, "provider-secret-canary"]) {
    const config = JSON.parse(original); config.unrelated = extra;
    await writeFile(configPath, JSON.stringify(config));
    if (extra === "provider-secret-canary") expect(await findSecretLeakInDirectory(home, [...secrets, extra], options)).not.toBeNull();
    else await expect(findSecretLeakInDirectory(home, secrets, options)).rejects.toThrow("custody");
  }
  await writeFile(configPath, original);
  await writeFile(path.join(home, "copy.json"), original, { mode: 0o600 });
  expect((await findSecretLeakInDirectory(home, secrets, options))?.file).toBe(path.join(home, "copy.json"));
  await rm(path.join(home, "copy.json"));
  const wrong = JSON.parse(original); wrong.database.connectionString = "postgresql://foreign";
  await writeFile(configPath, JSON.stringify(wrong));
  await expect(findSecretLeakInDirectory(home, secrets, options)).rejects.toThrow("receipt");
  // Duplicate keys and alternate raw occurrences never disappear through JSON parse.
  await writeFile(configPath, original.replace('"connectionString":', '"connectionString":'+JSON.stringify(owned.receipt.connectionString)+',"connectionString":'));
  await expect(findSecretLeakInDirectory(home, secrets, options)).rejects.toThrow("one exact");
  await writeFile(configPath, original); await chmod(configPath, 0o644);
  await expect(findSecretLeakInDirectory(home, secrets, options)).rejects.toThrow("metadata");
  await chmod(configPath, 0o600); await chmod(home, 0o755);
  await expect(findSecretLeakInDirectory(home, secrets, options)).rejects.toThrow("metadata");
  await chmod(home, 0o700);
  await expect(findSecretLeakInDirectory(temp, secrets, options)).rejects.toThrow("isolated home");
  const bytes = await readFile(configPath); await rm(configPath); await writeFile(configPath+"-target", bytes, { mode: 0o600 }); await symlink(configPath+"-target", configPath);
  await expect(findSecretLeakInDirectory(home, secrets, options)).rejects.toThrow("metadata");
  await rm(configPath); await writeFile(configPath, bytes, { mode: 0o600 });
  expect(createSanitizedCodexEnvironment({ DATABASE_URL: owned.receipt.connectionString, DATABASE_MIGRATION_URL: owned.receipt.connectionString }).DATABASE_URL).toBeUndefined();
  await owned.close();
  await expect(findSecretLeakInDirectory(home, secrets, options)).rejects.toThrow("not ready");
});
it("requires exact current UID, type and private custody modes", () => {
  const metadata = { uid: process.getuid!(), mode: 0o600, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
  expect(() => assertDockerCustodyMetadata(metadata, false)).not.toThrow();
  expect(() => assertDockerCustodyMetadata({ ...metadata, uid: metadata.uid+1 }, false)).toThrow();
  expect(() => assertDockerCustodyMetadata({ ...metadata, mode: 0o640 }, false)).toThrow();
  expect(() => assertDockerCustodyMetadata({ ...metadata, isSymbolicLink: () => true }, false)).toThrow();
  expect(() => assertDockerCustodyMetadata(metadata, true)).toThrow();
});

it("keeps historical arm64 identity unchanged and admits only the explicit reviewed amd64 artifact", () => {
  expect(databaseFingerprintIdentity({ [DATABASE_LANE_ENV]: "owned-docker-postgres" })).toEqual({ lane: "owned-docker-postgres", image: POSTGRES_IMAGE, imageId: POSTGRES_IMAGE_ID, version: POSTGRES_VERSION });
  const remote = databaseFingerprintIdentity({ [DATABASE_LANE_ENV]: "owned-docker-postgres", [POSTGRES_ARTIFACT_ENV]: "linux-amd64", [POSTGRES_IMAGE_ID_ENV]: POSTGRES_AMD64_IMAGE_IDS[1] });
  expect(remote).toEqual({ lane: "owned-docker-postgres", image: POSTGRES_AMD64_IMAGE, imageId: POSTGRES_AMD64_IMAGE_IDS[1], version: POSTGRES_VERSION, architecture: "amd64" });
  expect(() => selectedPostgresArtifact({ [POSTGRES_ARTIFACT_ENV]: "linux-amd64", [POSTGRES_IMAGE_ID_ENV]: "foreign" })).toThrow("Unreviewed");
  expect(() => selectedPostgresArtifact({ [POSTGRES_IMAGE_ID_ENV]: POSTGRES_AMD64_IMAGE_IDS[0] })).toThrow("Undeclared");
});
it("creates, verifies and cleans the explicit amd64 receipt using only the owned fake daemon", async () => {
  vi.stubEnv(POSTGRES_ARTIFACT_ENV, "linux-amd64"); vi.stubEnv(POSTGRES_IMAGE_ID_ENV, POSTGRES_AMD64_IMAGE_IDS[0]);
  const temp = await root(), { run, state } = daemon(); const owned = await startOwnedDockerDatabase({ temporaryRoot: temp, privateSecrets: [], run });
  expect(owned.receipt).toMatchObject({ image: POSTGRES_AMD64_IMAGE, imageId: POSTGRES_AMD64_IMAGE_IDS[0], architecture: "amd64", artifactVerified: true });
  expect(databaseIdentityMatches(databaseFingerprintIdentity({ [DATABASE_LANE_ENV]: "owned-docker-postgres", [POSTGRES_ARTIFACT_ENV]: "linux-amd64" }), publicDockerDatabaseIdentity(owned.receipt))).toBe(true);
  expect(databaseIdentityMatches(databaseFingerprintIdentity({ [DATABASE_LANE_ENV]: "owned-docker-postgres" }), publicDockerDatabaseIdentity(owned.receipt))).toBe(false);
  await owned.close(); expect(state.container).toBeNull(); expect(state.volume).toBeNull(); expect(owned.receipt.status).toBe("removed");
  const result = { schema: "paperclip.runner-e2e.result/v1", executionId: "remote-offline", attempt: 1, status: "passed", profileId: "offline", environmentId: "local", caseId: "offline", provider: null, model: null, runtimeMode: "none", startedAt: "2026-10-27T00:00:00Z", finishedAt: "2026-10-27T00:00:01Z", durationMs: 1000, cleanup: "passed", databaseIdentity: publicDockerDatabaseIdentity(owned.receipt) };
  expect(() => validateRetainedRunnerResult(result)).not.toThrow();
  for (const change of [{ architecture: undefined }, { image: POSTGRES_IMAGE }, { imageId: POSTGRES_IMAGE_ID }]) expect(() => validateRetainedRunnerResult({ ...result, databaseIdentity: { ...result.databaseIdentity, ...change } })).toThrow();
});
