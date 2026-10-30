import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { MANAGED_DATABASE_HTTP, managedDatabaseUploadPreamble } from "@paperclipai/shared/managed-database";
import type {
  ManagedDatabaseCommand,
  ManagedDatabaseConfig,
  ManagedDatabaseLeaseRef,
  ManagedDatabaseReceipt,
} from "@paperclipai/shared/managed-database";
import { signManagedDatabasePayload } from "@paperclipai/shared/managed-database-server";
import { getEmbeddedPostgresTestSupport } from "./embedded-postgres.js";
import { resolveEngineBinaries, type EngineBinaries } from "../../managed-database/engine.js";
import { managedDatabaseLayout } from "../../managed-database/layout.js";
import { readRelease } from "../../managed-database/main.js";
import { resolvePgClientTools, type PgClientTools } from "../../managed-database/snapshots.js";
import {
  ManagedDatabaseSupervisor,
  type ManagedDatabaseSupervisorOptions,
  type SupervisorLogger,
} from "../../managed-database/supervisor.js";

export type ManagedDatabaseTestSupport =
  | { supported: true; engine: EngineBinaries; pgTools: PgClientTools | null }
  | { supported: false; reason: string };

/** Real-engine tests need the bundled engine; snapshot tests also need pg_dump/pg_restore 18. */
export async function getManagedDatabaseTestSupport(): Promise<ManagedDatabaseTestSupport> {
  const embedded = await getEmbeddedPostgresTestSupport();
  if (!embedded.supported) return { supported: false, reason: embedded.reason ?? "embedded PostgreSQL unsupported" };
  try {
    const engine = await resolveEngineBinaries();
    return { supported: true, engine, pgTools: await resolvePgClientTools(engine.major) };
  } catch (error) {
    return { supported: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

export const quietLogger: SupervisorLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Treats the test volume as its own filesystem; "/" is device 1. */
export const mountedDeviceOf = (target: string) => (target === "/" ? 1 : 2);

export type TestStack = {
  volume: string;
  config: ManagedDatabaseConfig;
  controlKey: Buffer;
  pgPort: number;
  cleanup(): void;
};

export async function createTestStack(overrides: Partial<ManagedDatabaseConfig> = {}): Promise<TestStack> {
  const volume = mkdtempSync(path.join(os.tmpdir(), "paperclip-mdb-vol-"));
  const config: ManagedDatabaseConfig = {
    v: 1,
    provider: "embedded",
    stackId: `stk_${randomBytes(4).toString("hex")}`,
    configGeneration: 1,
    engineMajor: 18,
    mode: "maintenance",
    volume: { id: `vol_${randomBytes(4).toString("hex")}`, mountPath: volume },
    cluster: { state: "initialize", initializationId: `init_${randomBytes(4).toString("hex")}` },
    root: path.join(volume, ".managed-database"),
    ...overrides,
  };
  return {
    volume,
    config,
    controlKey: randomBytes(32),
    pgPort: await freePort(),
    cleanup: () => rmSync(volume, { recursive: true, force: true }),
  };
}

export async function buildSupervisor(
  stack: TestStack,
  support: Extract<ManagedDatabaseTestSupport, { supported: true }>,
  overrides: Partial<ManagedDatabaseSupervisorOptions> = {},
): Promise<ManagedDatabaseSupervisor> {
  return new ManagedDatabaseSupervisor({
    config: stack.config,
    controlKey: stack.controlKey,
    env: {},
    engine: support.engine,
    pgTools: support.pgTools,
    release: await readRelease(),
    dbIdentity: null,
    appIdentity: null,
    pgPort: stack.pgPort,
    deviceOf: mountedDeviceOf,
    logger: quietLogger,
    engineRestartDelaysMs: [0, 200, 500],
    ...overrides,
  });
}

/** Config for the next generation after first init, as the harness would write it. */
export function establishedConfig(
  config: ManagedDatabaseConfig,
  systemIdentifier: string,
  patch: Partial<ManagedDatabaseConfig> = {},
): ManagedDatabaseConfig {
  return {
    ...config,
    configGeneration: config.configGeneration + 1,
    cluster: { state: "existing", initializationId: config.cluster.initializationId, systemIdentifier },
    ...patch,
  };
}

type CommandInput = { kind: ManagedDatabaseCommand["kind"]; args?: Record<string, unknown>; lease?: ManagedDatabaseLeaseRef };

export function buildCommand(stack: Pick<TestStack, "config">, input: CommandInput, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    stackId: stack.config.stackId,
    configGeneration: stack.config.configGeneration,
    commandId: `cmd_${randomUUID()}`,
    issuedAt: new Date().toISOString(),
    kind: input.kind,
    args: input.args ?? {},
    ...(input.lease ? { lease: input.lease } : {}),
    ...overrides,
  };
}

export async function sendCommand(
  supervisor: ManagedDatabaseSupervisor,
  stack: Pick<TestStack, "config" | "controlKey">,
  input: CommandInput,
  overrides: Record<string, unknown> = {},
  key: Buffer = stack.controlKey,
): Promise<{ status: number; receipt: ManagedDatabaseReceipt; body: Record<string, unknown> }> {
  const body = buildCommand(stack, input, overrides);
  const response = await supervisor.handleCommand(body, signManagedDatabasePayload(key, "command", body));
  return { status: response.status, receipt: response.body as ManagedDatabaseReceipt, body };
}

export async function acquireLease(
  supervisor: ManagedDatabaseSupervisor,
  stack: Pick<TestStack, "config" | "controlKey">,
  ttlSeconds = 600,
): Promise<ManagedDatabaseLeaseRef> {
  const { status, receipt } = await sendCommand(supervisor, stack, { kind: "lease.acquire", args: { holder: "test", ttlSeconds } });
  if (status !== 200) throw new Error(`lease.acquire failed: ${JSON.stringify(receipt)}`);
  const lease = receipt.details.lease as { id: string; epoch: number };
  return { id: lease.id, epoch: lease.epoch };
}

/** Connection as the tenant app role, from the env the supervisor gives the app. */
export function appSql(supervisor: ManagedDatabaseSupervisor, which: "app" | "plugin" = "app") {
  const env = supervisor.appEnvironment();
  const url = which === "app" ? env.DATABASE_URL! : env.PAPERCLIP_PLUGIN_MIGRATION_DATABASE_URL!;
  return postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 5 });
}

/** Superuser connection through the supervisor's socket (test inspection only). */
export function superuserSql(stack: Pick<TestStack, "config" | "pgPort">, database = "paperclip") {
  const layout = managedDatabaseLayout(stack.config);
  const secrets = JSON.parse(readFileSync(layout.secretsFile, "utf8")) as { supervisorPassword: string };
  return postgres({
    host: layout.socketDir,
    port: stack.pgPort,
    user: "paperclip_supervisor",
    password: secrets.supervisorPassword,
    database,
    max: 1,
    onnotice: () => {},
  });
}

export type SocketResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };

/** HTTP over the supervisor control socket. */
export async function socketRequest(
  socketPath: string,
  method: string,
  urlPath: string,
  headers: Record<string, string>,
  body?: Buffer | string,
): Promise<SocketResponse> {
  return await new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, method, path: urlPath, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** PUT archive request: the signature header, and a body of command line + archive. */
export function signedUpload(key: Buffer, command: Record<string, unknown>, archive: Buffer): { headers: Record<string, string>; body: Buffer } {
  return {
    headers: {
      "content-type": "application/octet-stream",
      [MANAGED_DATABASE_HTTP.signatureHeader]: signManagedDatabasePayload(key, "command", command),
    },
    body: Buffer.concat([Buffer.from(managedDatabaseUploadPreamble(command)), archive]),
  };
}

export async function uploadArchive(socketPath: string, upload: { headers: Record<string, string>; body: Buffer }): Promise<SocketResponse> {
  return await socketRequest(socketPath, "PUT", MANAGED_DATABASE_HTTP.archive, upload.headers, upload.body);
}

export function signedArchiveHeaders(key: Buffer, body: Record<string, unknown>): Record<string, string> {
  return {
    [MANAGED_DATABASE_HTTP.commandHeader]: Buffer.from(JSON.stringify(body)).toString("base64url"),
    [MANAGED_DATABASE_HTTP.signatureHeader]: signManagedDatabasePayload(key, "command", body),
  };
}
