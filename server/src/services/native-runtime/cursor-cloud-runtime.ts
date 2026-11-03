import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, fstatSync, fsyncSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { loadConfig } from "../../config.js";
import { archiveCursorCloudSessionCheckpoint, CURSOR_CLOUD_DEFAULT_TIMEOUT_MS, type NativeExecutionInput, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { createRemoteMcpRelayToken, registerRemoteMcpRelay, remoteMcpRelayUrl } from "./remote-mcp-relay.js";

export function resolveCursorCloudPublicOrigin(): string | undefined {
  return loadConfig().authPublicBaseUrl;
}

export function prepareCursorCloudRuntime(input: {
  db: Db;
  execution: NativeExecutionInput;
  root: string;
  environment: NodeJS.ProcessEnv;
  publicOrigin?: string;
  authorityCurrent?: () => boolean;
}) {
  const { execution } = input;
  if (execution.provider.kind !== "cursor_cloud") throw new Error("cursor_cloud_provider_required");
  if (!input.environment.CURSOR_API_KEY?.trim()) throw new Error("cursor_cloud_api_key_required: bind CURSOR_API_KEY to this agent");
  const origin = input.publicOrigin ?? resolveCursorCloudPublicOrigin();
  if (!origin) throw new Error("cursor_cloud_public_url_required: configure reachable HTTPS for the remote tool relay");
  const url = remoteMcpRelayUrl(origin, execution.binding.runId);
  const directory = join(input.root, "cursor-cloud");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const privateDirectory = (path: string) => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("cursor_cloud_runtime_directory_unsafe");
  };
  privateDirectory(directory);
  const binding = { ...execution.binding, normalizedSessionId: execution.session.normalizedSessionId ?? `session-${execution.binding.runId}` };
  const bindingDigest = createHash("sha256").update(JSON.stringify(binding)).digest("hex");
  const capabilityPath = join(directory, "relay-capability.json");
  let capability: { bindingDigest: string; token: string; expiresAt: number };
  if (existsSync(capabilityPath)) {
    const fd = openSync(capabilityPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("cursor_cloud_relay_capability_unsafe");
      capability = JSON.parse(readFileSync(fd, "utf8"));
    } finally { closeSync(fd); }
    if (capability.bindingDigest !== bindingDigest) capability = { bindingDigest, token: createRemoteMcpRelayToken(), expiresAt: Date.now() + (execution.provider.cursorCloud.timeoutMs ?? CURSOR_CLOUD_DEFAULT_TIMEOUT_MS) + 120_000 };
  } else capability = { bindingDigest, token: createRemoteMcpRelayToken(), expiresAt: Date.now() + (execution.provider.cursorCloud.timeoutMs ?? CURSOR_CLOUD_DEFAULT_TIMEOUT_MS) + 120_000 };
  if (typeof capability.token !== "string" || capability.token.length < 32 || !Number.isFinite(capability.expiresAt)) throw new Error("cursor_cloud_relay_capability_invalid");
  const savePrivate = (path: string, value: unknown) => {
    const prior = lstatSync(path, { throwIfNoEntry: false });
    if (prior && (!prior.isFile() || prior.isSymbolicLink() || (prior.mode & 0o077) !== 0 || (process.getuid && prior.uid !== process.getuid()))) throw new Error("cursor_cloud_runtime_file_unsafe");
    const pending = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { renameSync(pending, path); }
    finally { rmSync(pending, { force: true }); }
  };
  savePrivate(capabilityPath, capability);
  const socketRoot = `/tmp/paperclip-cloud-${createHash("sha256").update(input.root).digest("hex").slice(0, 24)}`;
  if (!existsSync(socketRoot)) mkdirSync(socketRoot, { mode: 0o700 });
  privateDirectory(socketRoot);
  const socketPath = join(socketRoot, "mcp.sock");
  const artifactRoot = join(directory, "artifacts");
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  privateDirectory(artifactRoot);
  const configPath = join(directory, "config.json");
  savePrivate(configPath, { ...execution.provider.cursorCloud, binding: {
    companyId: execution.binding.companyId, agentId: execution.binding.agentId,
    issueId: execution.binding.issueId, normalizedSessionId: binding.normalizedSessionId,
  } });
  let release: (() => void) | undefined;
  const register = (options?: { cleanupOnly?: boolean }) => {
    if (capability.expiresAt <= Date.now() && options?.cleanupOnly !== true) throw new Error("cursor_cloud_relay_capability_expired");
    release ??= registerRemoteMcpRelay({ runId: execution.binding.runId, socketPath, token: capability.token, expiresAt: capability.expiresAt,
    authorized: async () => {
      if (input.authorityCurrent && !input.authorityCurrent()) return false;
      const run = await input.db.select({ status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, execution.binding.runId), eq(heartbeatRuns.companyId, execution.binding.companyId),
        eq(heartbeatRuns.agentId, execution.binding.agentId), eq(heartbeatRuns.issueId, execution.binding.issueId),
      )).limit(1).then(rows => rows[0]);
      return run?.status === "running" && run.runtimeMode === "native" && (!input.authorityCurrent || input.authorityCurrent());
    } });
  };
  const archiveCheckpoint = async (archiveRoot: string, previous: PersistedNativeSession | undefined) => {
    if (!previous?.identity || previous.sessionId !== binding.normalizedSessionId || previous.identity.companyId !== execution.binding.companyId
      || previous.identity.agentId !== execution.binding.agentId || previous.identity.issueId !== execution.binding.issueId) throw new Error("cursor_cloud_replacement_binding_mismatch");
    await archiveCursorCloudSessionCheckpoint({ runtimeDirectory: directory, driverSessionId: previous.sessionId,
      ownerRunId: previous.identity.runId, binding: { companyId: execution.binding.companyId, agentId: execution.binding.agentId,
        issueId: execution.binding.issueId, normalizedSessionId: binding.normalizedSessionId }, socketPath,
      archiveDirectory: join(archiveRoot, "cursor-cloud") });
  };
  const unregister = () => { release?.(); release = undefined; };
  return { register, unregister, archiveCheckpoint, environment: { ...input.environment,
    PAPERCLIP_CURSOR_CLOUD_ARTIFACT_ROOT: artifactRoot, PAPERCLIP_CURSOR_CLOUD_CONFIG_PATH: configPath, PAPERCLIP_CURSOR_CLOUD_RELAY_SOCKET_PATH: socketPath,
    PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN: capability.token, PAPERCLIP_CURSOR_CLOUD_RELAY_URL: url,
    PAPERCLIP_CURSOR_CLOUD_RELAY_EXPIRES_AT: String(capability.expiresAt),
  } };
}
