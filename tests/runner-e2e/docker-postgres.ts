import { lstatSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
export const DATABASE_LANE_ENV = "PAPERCLIP_RUNNER_E2E_DATABASE_LANE";
export const DOCKER_DATABASE_ENV = "PAPERCLIP_RUNNER_E2E_DOCKER_DATABASE_RECEIPT";
export const POSTGRES_IMAGE = "postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336";
export const POSTGRES_IMAGE_ID = "sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336";
export const POSTGRES_VERSION = "18.6-1.pgdg13+2";
// Separate official Linux/amd64 artifact for GitHub AWS execution. Historical
// arm64 defaults/receipts keep their exact bytes and identities.
export const POSTGRES_ARTIFACT_ENV = "PAPERCLIP_RUNNER_E2E_POSTGRES_ARTIFACT";
export const POSTGRES_IMAGE_ID_ENV = "PAPERCLIP_RUNNER_E2E_POSTGRES_IMAGE_ID";
export const POSTGRES_AMD64_IMAGE = "postgres@sha256:9770878138a2e83abcb10856d30cc3f24dae0d317bb956db6ab9159de6c3c80d";
export const POSTGRES_AMD64_IMAGE_IDS = ["sha256:79061104669bb30919d015b549c764e2d8021a18ee39cb175581a2588fe90dbe", "sha256:9770878138a2e83abcb10856d30cc3f24dae0d317bb956db6ab9159de6c3c80d"] as const;
type PostgresImage = typeof POSTGRES_IMAGE | typeof POSTGRES_AMD64_IMAGE;
type PostgresImageId = typeof POSTGRES_IMAGE_ID | typeof POSTGRES_AMD64_IMAGE_IDS[number];
export function selectedPostgresArtifact(env = process.env): { image: PostgresImage; imageId: PostgresImageId; architecture: "arm64" | "amd64"; version: typeof POSTGRES_VERSION } {
  if (!env[POSTGRES_ARTIFACT_ENV]) {
    if (env[POSTGRES_IMAGE_ID_ENV]) throw new Error("Undeclared PostgreSQL image identity override");
    return { image: POSTGRES_IMAGE, imageId: POSTGRES_IMAGE_ID, architecture: "arm64" as const, version: POSTGRES_VERSION };
  }
  if (env[POSTGRES_ARTIFACT_ENV] !== "linux-amd64") throw new Error("Unknown explicit PostgreSQL artifact");
  const imageId = POSTGRES_AMD64_IMAGE_IDS.find(id => id === (env[POSTGRES_IMAGE_ID_ENV] ?? POSTGRES_AMD64_IMAGE_IDS[0]));
  if (!imageId) throw new Error("Unreviewed amd64 PostgreSQL image identity");
  return { image: POSTGRES_AMD64_IMAGE, imageId, architecture: "amd64" as const, version: POSTGRES_VERSION };
}
export function reviewedPostgresReceiptIdentity(receipt: { image: string; imageId: string; architecture?: string }) {
  return receipt.image === POSTGRES_IMAGE && receipt.imageId === POSTGRES_IMAGE_ID && !receipt.architecture
    || receipt.image === POSTGRES_AMD64_IMAGE && POSTGRES_AMD64_IMAGE_IDS.some(id => id === receipt.imageId) && receipt.architecture === "amd64";
}

export type DockerRun = (args: string[], timeout?: number) => Promise<string>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fullId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuidHex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const labelPrefix = "ai.paperclip.runner-e2e";
export interface DockerEngineIdentity { context: string; endpoint: string; engineId: string; operatingSystem: string }
export interface DockerDatabaseReceipt {
  schemaVersion: 1; lane: "owned-docker-postgres"; temporaryRoot: string; nonce: string;
  engine: DockerEngineIdentity; containerId: string | null; containerName: string; volumeName: string;
  image: PostgresImage; imageId: PostgresImageId; architecture?: "amd64"; imageVersion: typeof POSTGRES_VERSION;
  username: string; database: string; connectionString?: string; port?: number;
  status: "creating" | "ready" | "failed" | "removed" | "cleanup-failed";
  artifactVerified?: boolean;
  volumeCreationAttempted?: boolean; containerCreationAttempted?: boolean;
  startedAt: string; finishedAt?: string; primaryFailure?: string; cleanupFailures?: string[];
  cluster?: { version: string; database: string; username: string; systemIdentifier: string };
}
export function selectedDatabaseLane(env = process.env) {
  const lane = env[DATABASE_LANE_ENV];
  if (lane && !["embedded-postgres", "owned-docker-postgres"].includes(lane)) throw new Error("Unknown explicitly selected runner database lane");
  return lane ?? "embedded-postgres";
}
/** Docker is only a test-host control client. No provider or DB credential is
 * inherited by it; all commands pin the verified local context explicitly. */
interface CommandFailure { args: string[]; stdout: string; stderr: string; exitCode: number | null; signal: string | null; spawnCode?: string }
const commandFailures = new WeakMap<Error, CommandFailure>();
/** Raw command diagnostics are non-enumerable process-private provenance. */
export class DockerCommandError extends Error {
  constructor(details: CommandFailure) { super("Owned Docker command failed; raw diagnostics withheld"); commandFailures.set(this, details); }
}
/** Closed diagnostics only: Docker can print registry auth/config in raw stderr. */
export function dockerCommandDiagnostic(error: unknown) {
  const data = error instanceof Error ? commandFailures.get(error) : undefined;
  if (!data) return { category: error instanceof SyntaxError ? "invalid-json" : "unclassified-error" };
  const text = `${data.stdout}\n${data.stderr}`;
  const category = data.spawnCode === "ENOENT" ? "docker-command-missing"
    : /toomanyrequests|rate.limit|429/i.test(text) ? "registry-rate-limit"
    : /unauthorized|authentication required|denied:|forbidden/i.test(text) ? "registry-access-denied"
    : /cannot connect|is the docker daemon running|permission denied.*docker.sock|docker.sock.*permission denied/i.test(text) ? "docker-engine-unavailable"
    : /no matching manifest|does not match the specified platform/i.test(text) ? "image-platform-unavailable"
    : /manifest unknown|manifest.*not found/i.test(text) ? "image-manifest-unavailable"
    : /timeout|timed out|deadline exceeded/i.test(text) || data.spawnCode === "ETIMEDOUT" || data.signal === "SIGTERM" ? "command-timeout-or-termination"
    : /no such host|network is unreachable|connection refused|connection reset|TLS handshake|x509:|temporary failure in name resolution/i.test(text) ? "registry-network-or-tls-failure"
    : /no space left/i.test(text) ? "host-storage-exhausted" : "unknown-docker-command-failure";
  return { category, exitCode: data.exitCode, signal: data.signal === "SIGTERM" || data.signal === "SIGKILL" ? data.signal : null };
}
function verifiedNotFound(error: unknown, resource: string) {
  if (!(error instanceof Error)) return false;
  const data = commandFailures.get(error);
  if (!data || data.exitCode !== 1 || data.signal || data.args.at(-1) !== resource || !data.args.includes("inspect") || !["", "[]"].includes(data.stdout.trim())) return false;
  const name = resource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(?:Error(?: response from daemon)?: )?(?:No such (?:object|container|volume):? ${name}|get ${name}: no such volume)\\s*$`, "i").test(data.stderr.trim());
}
export const runDocker: DockerRun = async (args, timeout = 15000) => {
  try {
    const result = await promisify(execFile)("docker", args, { timeout, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...(process.env.DOCKER_CONFIG ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG } : {}) } });
    return (args.includes("logs") ? result.stdout + result.stderr : result.stdout).trim();
  } catch (cause) {
    const raw = cause as { stdout?: string; stderr?: string; code?: number | string; signal?: string };
    throw new DockerCommandError({ args, stdout: raw.stdout ?? "", stderr: raw.stderr ?? "", exitCode: typeof raw.code === "number" ? raw.code : null, signal: raw.signal ?? null,
      ...(raw.code === "ENOENT" || raw.code === "ETIMEDOUT" ? { spawnCode: raw.code } : {}) });
  }
};
export async function currentDockerEngine(run: DockerRun = runDocker, env = process.env): Promise<DockerEngineIdentity> {
  if (env.DOCKER_HOST && !env.DOCKER_HOST.startsWith("unix://")) throw new Error("Remote Docker hosts are not admitted");
  const context = env.DOCKER_CONTEXT || await run(["context", "show"]);
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(context)) throw new Error("Invalid local Docker context identity");
  const rows = JSON.parse(await run(["context", "inspect", context]));
  const endpoint = rows?.[0]?.Endpoints?.docker?.Host;
  if (rows.length !== 1 || typeof endpoint !== "string" || !endpoint.startsWith("unix:///") || endpoint.includes("\n") || env.DOCKER_HOST && env.DOCKER_HOST !== endpoint) throw new Error("Docker context must resolve to the exact local Unix socket");
  const info = JSON.parse(await run(["--context", context, "info", "--format", '{"id":{{json .ID}},"os":{{json .OSType}},"operatingSystem":{{json .OperatingSystem}}}']));
  if (info.os !== "linux" || typeof info.id !== "string" || !info.id.trim()) throw new Error("A running local Linux Docker engine is required");
  if (typeof info.operatingSystem !== "string") throw new Error("Docker engine operating-system identity is missing");
  return { context, endpoint, engineId: info.id, operatingSystem: info.operatingSystem };
}
async function pinnedEngine(expected: DockerEngineIdentity, run: DockerRun) {
  const observed = await currentDockerEngine(run);
  if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error("Docker context or engine changed; owned operations refused");
}
function labels(receipt: DockerDatabaseReceipt) { return { [`${labelPrefix}.kind`]: "postgres", [`${labelPrefix}.nonce`]: receipt.nonce, [`${labelPrefix}.root`]: hash(receipt.temporaryRoot), [`${labelPrefix}.uid`]: String(process.getuid?.() ?? "unknown") }; }
function hasLabels(actual: Record<string, string> | undefined, receipt: DockerDatabaseReceipt) { return !!actual && Object.entries(labels(receipt)).every(([k, v]) => actual[k] === v); }
export function assertOwnedVolume(value: any, receipt: DockerDatabaseReceipt) {
  if (!value || value.Name !== receipt.volumeName || value.Driver !== "local" || value.Scope !== "local" || Object.keys(value.Options ?? {}).length || !hasLabels(value.Labels, receipt)) throw new Error("Docker volume ownership/configuration mismatch");
}
function exactPasswordBindSource(source: unknown, receipt: DockerDatabaseReceipt) {
  const expected = path.join(receipt.temporaryRoot, "docker-postgres-private", "password");
  if (source === expected) return true;
  // Docker Desktop exposes its exact host bind through this Linux VM prefix.
  // Never accept arbitrary suffixes, another engine, another root or a symlink.
  if (receipt.engine.operatingSystem !== "Docker Desktop" || source !== `/host_mnt${expected}`) return false;
  try {
    const entry = lstatSync(expected);
    return entry.isFile() && !entry.isSymbolicLink() && entry.uid === process.getuid?.()
      && (entry.mode & 0o777) === 0o600 && realpathSync(expected) === expected;
  } catch { return false; }
}
export function assertOwnedContainer(value: any, receipt: DockerDatabaseReceipt, running?: boolean) {
  const mounts = value?.Mounts, data = mounts?.find((m: any) => m.Destination === "/var/lib/postgresql"), password = mounts?.find((m: any) => m.Destination === "/run/secrets/postgres-password");
  const ports = value?.HostConfig?.PortBindings?.["5432/tcp"], config = value?.Config;
  if (!fullId(receipt.containerId) || value?.Id !== receipt.containerId || value.Name !== `/${receipt.containerName}` || !reviewedPostgresReceiptIdentity(receipt) || value.Image !== receipt.imageId || config?.Image !== receipt.image || !hasLabels(config.Labels, receipt)
    || value.HostConfig.Privileged !== false || !["default", "bridge"].includes(value.HostConfig.NetworkMode) || !Array.isArray(mounts) || mounts.length !== 2
    || data?.Type !== "volume" || data.Name !== receipt.volumeName || data.RW !== true || password?.Type !== "bind" || !exactPasswordBindSource(password.Source, receipt) || password.RW !== false
    || !Array.isArray(ports) || ports.length !== 1 || ports[0].HostIp !== "127.0.0.1" || Object.keys(value.HostConfig.PortBindings).join() !== "5432/tcp"
    || !config.Env.includes("POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password") || !config.Env.includes(`POSTGRES_USER=${receipt.username}`) || !config.Env.includes(`POSTGRES_DB=${receipt.database}`) || config.Env.some((v: string) => /^POSTGRES_PASSWORD=/.test(v))
    || running !== undefined && value.State?.Running !== running) throw new Error("Docker container ownership/isolation mismatch");
  if (receipt.port !== undefined && value.State?.Running) {
    const mapped = value.NetworkSettings?.Ports?.["5432/tcp"];
    if (!Array.isArray(mapped) || mapped.length !== 1 || mapped[0].HostIp !== "127.0.0.1" || Number(mapped[0].HostPort) !== receipt.port) throw new Error("Docker loopback database mapping changed");
  }
}
async function privateRoot(root: string) {
  const s = await lstat(root);
  if (!path.basename(root).startsWith("paperclip-runner-e2e-") || await realpath(root) !== root || !s.isDirectory() || s.mode & 0o077 || s.uid !== process.getuid?.()) throw new Error("Docker database requires the exact owned private attempt root");
}
function assertReceipt(value: DockerDatabaseReceipt, root: string) {
  if (value?.schemaVersion !== 1 || value.lane !== "owned-docker-postgres" || value.temporaryRoot !== root || !uuidHex(value.nonce) || value.containerName !== `paperclip-e2e-pg-${value.nonce}` || value.volumeName !== `paperclip-e2e-pg-data-${value.nonce}`
    || !reviewedPostgresReceiptIdentity(value) || value.imageVersion !== POSTGRES_VERSION || !/^[a-z][a-z0-9_]{1,60}$/.test(value.username) || !/^[a-z][a-z0-9_]{1,60}$/.test(value.database)) throw new Error("Invalid private Docker database receipt");
}
async function readPrivateDockerReceipt(filename: string, root: string) {
  await privateRoot(root);
  if (filename !== path.join(root, "docker-postgres-private", "receipt.json")) throw new Error("Docker receipt escaped its owned attempt");
  const dir = await lstat(path.dirname(filename)), s = await lstat(filename);
  if (!dir.isDirectory() || await realpath(path.dirname(filename)) !== path.dirname(filename) || dir.mode & 0o077 || dir.uid !== process.getuid?.() || !s.isFile() || s.isSymbolicLink() || (s.mode & 0o777) !== 0o600 || s.uid !== process.getuid?.() || s.size > 32768) throw new Error("Unsafe private Docker receipt");
  const receipt = JSON.parse(await readFile(filename, "utf8")) as DockerDatabaseReceipt; assertReceipt(receipt, root);
  return receipt;
}
export async function readDockerDatabaseReceipt(filename: string, root: string, run: DockerRun = runDocker) {
  const receipt = await readPrivateDockerReceipt(filename, root);
  if (receipt.status !== "ready" || !receipt.connectionString || !receipt.port || !fullId(receipt.containerId)) throw new Error("Owned Docker database is not ready");
  const url = new URL(receipt.connectionString);
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== String(receipt.port) || decodeURIComponent(url.username) !== receipt.username || url.pathname !== `/${receipt.database}` || !/^[a-f0-9]{64}$/.test(url.password) || url.search || url.hash) throw new Error("Docker database URL differs from owned receipt");
  const passwordPath = path.join(root, "docker-postgres-private", "password"), passwordStat = await lstat(passwordPath);
  if (!passwordStat.isFile() || passwordStat.isSymbolicLink() || (passwordStat.mode & 0o777) !== 0o600 || passwordStat.uid !== process.getuid?.() || await readFile(passwordPath, "utf8") !== url.password) throw new Error("Docker private password binding differs from receipt");
  await pinnedEngine(receipt.engine, run);
  assertOwnedContainer(JSON.parse(await run(["--context", receipt.engine.context, "inspect", receipt.containerId]))[0], receipt, true);
  assertOwnedVolume(JSON.parse(await run(["--context", receipt.engine.context, "volume", "inspect", receipt.volumeName]))[0], receipt);
  return receipt;
}
export interface DockerDatabaseIdentity {
  lane: "owned-docker-postgres"; image: PostgresImage; imageId: PostgresImageId; architecture?: "amd64"; imageVersion: typeof POSTGRES_VERSION;
  artifactVerified: boolean; contextSha256: string | null; engineSha256: string | null; containerId: string | null;
  cluster?: { version: string; systemIdentifier: string }; status: DockerDatabaseReceipt["status"] | "startup-unconfirmed";
}
export function publicDockerDatabaseIdentity(receipt: DockerDatabaseReceipt): DockerDatabaseIdentity { return { lane: receipt.lane, image: receipt.image, imageId: receipt.imageId, imageVersion: receipt.imageVersion, ...(receipt.architecture ? { architecture: receipt.architecture } : {}), artifactVerified: receipt.artifactVerified === true, contextSha256: hash(`${receipt.engine.context}\n${receipt.engine.endpoint}`), engineSha256: hash(receipt.engine.engineId), containerId: receipt.containerId, cluster: receipt.cluster ? { version: receipt.cluster.version, systemIdentifier: receipt.cluster.systemIdentifier } : undefined, status: receipt.status }; }
/** Also used when startup throws before returning a ready handle. Never confuse
 * an unavailable receipt/daemon with proven absence or embedded fallback. */
export async function dockerDatabaseLaunchState(lane: string, root: string) {
  if (lane === "embedded-postgres") return { allowDarwinReap: true, cleanupUnconfirmed: false, identity: undefined };
  const artifact = selectedPostgresArtifact();
  const unknown: DockerDatabaseIdentity = { lane: "owned-docker-postgres", image: artifact.image, imageId: artifact.imageId, imageVersion: POSTGRES_VERSION, ...(artifact.architecture === "amd64" ? { architecture: artifact.architecture } : {}), artifactVerified: false, contextSha256: null, engineSha256: null, containerId: null, status: "startup-unconfirmed" };
  try {
    const receipt = await readPrivateDockerReceipt(path.join(root, "docker-postgres-private", "receipt.json"), root);
    return { allowDarwinReap: false, cleanupUnconfirmed: receipt.status !== "removed" || !!receipt.cleanupFailures?.length, identity: publicDockerDatabaseIdentity(receipt) };
  } catch { return { allowDarwinReap: false, cleanupUnconfirmed: true, identity: unknown }; }
}
export async function startOwnedDockerDatabase(input: { temporaryRoot: string; privateSecrets: string[]; run?: DockerRun }) {
  const artifact = selectedPostgresArtifact();
  const rawRun = input.run ?? runDocker, root = input.temporaryRoot; await privateRoot(root);
  const startupDeadline = Date.now() + 120000; let cleaning = false;
  const run: DockerRun = (args, timeout = 15000) => {
    const remaining = cleaning ? timeout : Math.min(timeout, startupDeadline - Date.now());
    if (remaining <= 0) throw new Error("Owned Docker startup deadline expired");
    return rawRun(args, remaining);
  };
  const engine = await currentDockerEngine(run), nonce = randomBytes(16).toString("hex"), password = randomBytes(32).toString("hex"), directory = path.join(root, "docker-postgres-private"), filename = path.join(directory, "receipt.json");
  await mkdir(directory, { mode: 0o700 });
  const receipt: DockerDatabaseReceipt = { schemaVersion: 1, lane: "owned-docker-postgres", temporaryRoot: root, nonce, engine, containerId: null, containerName: `paperclip-e2e-pg-${nonce}`, volumeName: `paperclip-e2e-pg-data-${nonce}`, image: artifact.image, imageId: artifact.imageId, imageVersion: POSTGRES_VERSION, ...(artifact.architecture === "amd64" ? { architecture: artifact.architecture } : {}), username: `pc_${nonce.slice(0, 20)}`, database: `pc_${nonce.slice(0, 20)}`, status: "creating", startedAt: new Date().toISOString() };
  input.privateSecrets.push(password); await writeFile(path.join(directory, "password"), password, { mode: 0o600, flag: "wx" });
  const persist = () => writeFile(filename, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }); await persist();
  const command = async (args: string[], timeout?: number) => { await pinnedEngine(engine, run); return run(["--context", engine.context, ...args], timeout); };
  let closed = false;
  const close = async () => {
    if (closed) return; cleaning = true;
    const failures: string[] = [];
    let containerAbsent = !receipt.containerCreationAttempted;
    if (receipt.containerCreationAttempted) {
      const target = receipt.containerId ?? receipt.containerName;
      try {
        const value = JSON.parse(await command(["inspect", target]))[0];
        const recovered = { ...receipt, containerId: receipt.containerId ?? value?.Id };
        assertOwnedContainer(value, recovered); receipt.containerId = recovered.containerId; await persist();
        if (value.State.Running) await command(["stop", "--time", "10", receipt.containerId!], 30000);
        assertOwnedContainer(JSON.parse(await command(["inspect", receipt.containerId!]))[0], receipt, false);
        await command(["rm", receipt.containerId!]);
        // A successful rm acknowledgement is not the absence proof.
        try { await command(["inspect", receipt.containerId!]); throw new Error("Owned container remained after removal"); }
        catch (error) { if (!verifiedNotFound(error, receipt.containerId!)) throw error; }
        containerAbsent = true;
      } catch (error) {
        if (verifiedNotFound(error, target) || receipt.containerId && verifiedNotFound(error, receipt.containerId)) containerAbsent = true;
        else failures.push("Exact owned container absence is unconfirmed");
      }
    }
    if (receipt.volumeCreationAttempted) {
      if (!containerAbsent) failures.push("Owned volume retained because container absence is unconfirmed");
      else try {
        assertOwnedVolume(JSON.parse(await command(["volume", "inspect", receipt.volumeName]))[0], receipt);
        await command(["volume", "rm", receipt.volumeName]);
        try { await command(["volume", "inspect", receipt.volumeName]); throw new Error("Owned volume remained after removal"); }
        catch (error) { if (!verifiedNotFound(error, receipt.volumeName)) throw error; }
      } catch (error) { if (!verifiedNotFound(error, receipt.volumeName)) failures.push("Exact owned volume absence is unconfirmed"); }
    }
    receipt.status = failures.length ? "cleanup-failed" : "removed"; receipt.cleanupFailures = failures; receipt.finishedAt = new Date().toISOString(); await persist();
    if (failures.length) throw new Error(failures.join("; "));
    closed = true; await rm(path.join(directory, "password"), { force: true });
  };
  try {
    const image = JSON.parse(await command(["image", "inspect", artifact.image]))[0];
    if (image?.Id !== artifact.imageId || image.Os !== "linux" || image.Architecture !== artifact.architecture || !image.RepoDigests?.includes(artifact.image) || !image.Config.Env.includes(`PG_VERSION=${POSTGRES_VERSION}`)) throw new Error("Installed official PostgreSQL artifact differs from pinned identity; no pull permitted");
    receipt.artifactVerified = true; await persist();
    const labelArgs = Object.entries(labels(receipt)).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
    receipt.volumeCreationAttempted = true; await persist();
    await command(["volume", "create", "--driver", "local", ...labelArgs, receipt.volumeName]);
    assertOwnedVolume(JSON.parse(await command(["volume", "inspect", receipt.volumeName]))[0], receipt);
    receipt.containerCreationAttempted = true; await persist();
    const cid = await command(["create", "--cidfile", path.join(directory, "container.id"), "--pull=never", "--name", receipt.containerName, ...labelArgs, "--publish", "127.0.0.1::5432/tcp", "--memory", "1g", "--cpus", "2", "--pids-limit", "256", "--shm-size", "128m", "--mount", `type=volume,src=${receipt.volumeName},dst=/var/lib/postgresql`, "--mount", `type=bind,src=${path.join(directory, "password")},dst=/run/secrets/postgres-password,readonly`, "--env", "POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password", "--env", `POSTGRES_USER=${receipt.username}`, "--env", `POSTGRES_DB=${receipt.database}`, artifact.image]);
    if (!fullId(cid)) throw new Error("Docker create returned no exact container ID"); receipt.containerId = cid; await persist();
    assertOwnedContainer(JSON.parse(await command(["inspect", cid]))[0], receipt, false); await command(["start", cid], 20000);
    const deadline = Date.now() + 60000; let ready = false;
    while (Date.now() < deadline) { const value = JSON.parse(await command(["inspect", cid]))[0]; assertOwnedContainer(value, receipt); if (!value.State.Running) throw new Error("Owned PostgreSQL container stopped during initialization"); try { await command(["exec", cid, "pg_isready", "-h", "127.0.0.1", "-U", receipt.username, "-d", receipt.database], 5000); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); } }
    if (!ready) throw new Error("Owned PostgreSQL readiness deadline expired");
    const observed = JSON.parse(await command(["inspect", cid]))[0], mapped = observed.NetworkSettings?.Ports?.["5432/tcp"];
    if (!Array.isArray(mapped) || mapped.length !== 1 || mapped[0].HostIp !== "127.0.0.1" || !/^[0-9]+$/.test(mapped[0].HostPort) || Number(mapped[0].HostPort) < 1024 || Number(mapped[0].HostPort) > 65535) throw new Error("Owned PostgreSQL published port is not private loopback");
    receipt.port = Number(mapped[0].HostPort); receipt.connectionString = `postgresql://${receipt.username}:${password}@127.0.0.1:${receipt.port}/${receipt.database}`; input.privateSecrets.push(receipt.connectionString);
    const cluster = JSON.parse(await command(["exec", cid, "psql", "-X", "-U", receipt.username, "-d", receipt.database, "-At", "-c", "SELECT json_build_object('version',current_setting('server_version'),'database',current_database(),'username',current_user,'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()))"]));
    if (!/^18\.6(?:\s|$)/.test(cluster.version) || cluster.database !== receipt.database || cluster.username !== receipt.username || !/^[0-9]+$/.test(cluster.systemIdentifier)) throw new Error("Owned PostgreSQL cluster identity/version mismatch");
    receipt.cluster = cluster; receipt.status = "ready"; await persist(); await readDockerDatabaseReceipt(filename, root, run);
    return { filename, receipt, verify: () => readDockerDatabaseReceipt(filename, root, run), close };
  } catch (error) {
    receipt.status = "failed"; receipt.primaryFailure = error instanceof Error ? error.message : "Owned Docker PostgreSQL startup failed";
    const failure = error instanceof Error ? commandFailures.get(error) : undefined;
    if (failure) await writeFile(path.join(directory, "startup-command-failure.json"), JSON.stringify(failure), { mode: 0o600 });
    if (receipt.containerId) try { await writeFile(path.join(directory, "postgres.log"), await command(["logs", "--tail", "200", receipt.containerId]), { mode: 0o600 }); } catch { /* Preserve primary failure even if logs unavailable. */ }
    await persist(); try { await close(); } catch { throw new Error("Owned Docker PostgreSQL startup failed and cleanup is unconfirmed; private receipt retained"); }
    throw new Error("Owned Docker PostgreSQL startup failed; primary failure and diagnostics retained privately");
  }
}

/** Supervisor consumes the private receipt, then removes both admission keys
 * before constructing the actual Paperclip/native environment. */
export async function dockerDatabaseSupervisorEnvironment(input: { temporaryRoot: string; env: NodeJS.ProcessEnv; run?: DockerRun }) {
  const lane = selectedDatabaseLane(input.env), source = { ...input.env }, filename = source[DOCKER_DATABASE_ENV];
  delete source[DOCKER_DATABASE_ENV]; delete source[DATABASE_LANE_ENV]; delete source[POSTGRES_ARTIFACT_ENV]; delete source[POSTGRES_IMAGE_ID_ENV];
  if (lane === "embedded-postgres") { if (filename) throw new Error("Undeclared Docker database receipt"); return { source, filename: undefined }; }
  if (!filename) throw new Error("Selected Docker database lane is missing its owned receipt");
  await readDockerDatabaseReceipt(filename, input.temporaryRoot, input.run);
  for (const key of ["DOCKER_CONFIG", "DOCKER_HOST", "DOCKER_CONTEXT"]) delete source[key];
  return { source, filename };
}

export function databaseFingerprintIdentity(env = process.env) {
  const artifact = selectedPostgresArtifact(env);
  return selectedDatabaseLane(env) === "owned-docker-postgres"
    ? { lane: "owned-docker-postgres" as const, image: artifact.image, imageId: artifact.imageId, version: POSTGRES_VERSION, ...(artifact.architecture === "amd64" ? { architecture: artifact.architecture } : {}) }
    : { lane: "embedded-postgres" as const };
}
export type DatabaseFingerprintIdentity = ReturnType<typeof databaseFingerprintIdentity>;
export function databaseIdentityMatches(expected: DatabaseFingerprintIdentity, actual?: DockerDatabaseIdentity) {
  if (expected.lane === "embedded-postgres") return actual === undefined;
  return !!actual && actual.lane === expected.lane && actual.image === expected.image && actual.imageId === expected.imageId && actual.imageVersion === expected.version && reviewedPostgresReceiptIdentity(actual) && (expected.architecture ?? undefined) === actual.architecture
    && actual.artifactVerified && !!actual.contextSha256 && !!actual.engineSha256 && fullId(actual.containerId) && !!actual.cluster
    && /^18\.6(?:\s|$)/.test(actual.cluster.version) && /^[0-9]+$/.test(actual.cluster.systemIdentifier) && ["ready", "removed"].includes(actual.status);
}
