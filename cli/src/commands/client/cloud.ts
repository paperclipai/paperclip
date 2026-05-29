import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { URL } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import type {
  CompanyPortabilityExportResult,
  CompanyPortabilityFileEntry,
  InstanceExperimentalSettings,
} from "@paperclipai/shared";
import { openUrl } from "../../client/board-auth.js";
import { resolvePaperclipInstanceId } from "../../config/home.js";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";
import {
  buildLocalUpstreamExportBundle,
  LocalUpstreamPushCoordinator,
  normalizedContentHash,
  upstreamTransferSchema,
  UpstreamImportRequestError,
  type LocalUpstreamExportBundle,
  type LocalUpstreamExportEntityInput,
  type SourceEntityKey,
  type UpstreamTransferManifestSource,
  type UpstreamTransferManifestTarget,
  type UpstreamTransferWarning,
} from "./cloud-transfer.js";
import {
  getCloudConnection,
  upsertCloudConnection,
  type CloudConnection,
  type CloudConnectionTokenRecord,
} from "./cloud-store.js";

const CLOUD_SYNC_CONFLICT_EXIT_CODE = 2;
const CLOUD_SYNC_SCHEMA_MISMATCH_EXIT_CODE = 3;
const CLOUD_SYNC_SCOPES = ["upstream_import:preview", "upstream_import:write", "upstream_import:read"];
const DEVICE_CODE_FALLBACK_EXPIRES_MS = 15 * 60_000;

interface CloudConnectOptions extends BaseClientOptions {
  noBrowser?: boolean;
}

interface CloudPushOptions extends BaseClientOptions {
  company?: string;
  remoteUrl?: string;
  dryRun?: boolean;
  maxEntitiesPerChunk?: number;
}

interface UpstreamDiscovery {
  schema: string;
  stack: {
    id: string;
    slug?: string;
    displayName?: string;
    companyId: string;
    origin: string;
  };
  auth: {
    pkce?: {
      authorizeUrl: string;
      tokenUrl: string;
      codeChallengeMethod: string;
    };
    deviceCode?: {
      deviceCodeUrl: string;
      verificationUrl: string;
      tokenUrl: string;
    };
    scopes?: string[];
  };
  transfer: {
    supportedSchemaMajor: number;
    featureFlags?: string[];
  };
}

interface TokenResponse {
  accessToken: string;
  token: CloudConnectionTokenRecord;
  scopes?: string[];
  expiresAt?: string;
}

class CloudAuthRequestError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function registerCloudCommands(program: Command): void {
  const cloud = program.command("cloud").description("Paperclip Cloud upstream sync commands");

  addCommonClientOptions(
    cloud
      .command("connect")
      .description("Authorize this local instance to push into a Paperclip Cloud stack")
      .argument("<remote-url>", "Paperclip Cloud stack URL")
      .option("--no-browser", "Use the device-code flow instead of opening a browser", false)
      .action(async (remoteUrl: string, opts: CloudConnectOptions) => {
        try {
          await connectCloud(remoteUrl, opts);
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    cloud
      .command("push")
      .description("Preview or apply a local company push into the connected Paperclip Cloud stack")
      .requiredOption("--company <local-company-id>", "Local company ID to export")
      .option("--remote-url <remote-url>", "Use a specific stored cloud connection")
      .option("--dry-run", "Preview without applying", false)
      .option("--max-entities-per-chunk <count>", "Chunk size for upstream uploads", (value) => Number(value), 100)
      .action(async (opts: CloudPushOptions) => {
        try {
          await pushCloud(opts);
        } catch (err) {
          if (isSchemaMismatchError(err)) {
            console.error(pc.red(err instanceof Error ? err.message : String(err)));
            process.exitCode = CLOUD_SYNC_SCHEMA_MISMATCH_EXIT_CODE;
            return;
          }
          handleCommandError(err);
        }
      }),
  );
}

export async function connectCloud(remoteUrl: string, opts: CloudConnectOptions = {}): Promise<CloudConnection> {
  const ctx = resolveCommandContext(opts);
  const discovery = await discoverUpstream(remoteUrl);
  assertDiscoveryCompatible(discovery);
  const source = createSourceIdentity();
  const token = await authorizeConnection(discovery, source, {
    noBrowser: Boolean(opts.noBrowser),
  });
  const targetOrigin = discovery.stack.origin.replace(/\/+$/u, "");
  const targetHost = new URL(targetOrigin).host;
  const now = new Date().toISOString();
  const connection = upsertCloudConnection({
    id: connectionId(targetOrigin),
    remoteUrl,
    targetOrigin,
    targetHost,
    stackId: discovery.stack.id,
    stackSlug: discovery.stack.slug ?? null,
    stackDisplayName: discovery.stack.displayName ?? null,
    targetCompanyId: discovery.stack.companyId,
    accessToken: token.accessToken,
    token: token.token,
    privateKeyPem: source.privateKeyPem,
    sourcePublicKey: source.sourcePublicKey,
    sourceInstanceId: source.sourceInstanceId,
    sourceInstanceFingerprint: source.sourceInstanceFingerprint,
    scopes: token.scopes ?? token.token.scopes ?? CLOUD_SYNC_SCOPES,
    createdAt: now,
    updatedAt: now,
  });

  if (ctx.json) {
    printOutput(redactConnection(connection), { json: true });
  } else {
    console.log(pc.bold("Connected to Paperclip Cloud"));
    console.log(`stack=${connection.stackDisplayName ?? connection.stackSlug ?? connection.stackId}`);
    console.log(`origin=${connection.targetOrigin}`);
    console.log(`company=${connection.targetCompanyId}`);
  }
  return connection;
}

export async function pushCloud(opts: CloudPushOptions): Promise<unknown> {
  const ctx = resolveCommandContext(opts, { requireCompany: false });
  const localCompanyId = requiredString(opts.company, "--company");
  await assertCloudSyncEnabled(ctx.api.get<InstanceExperimentalSettings>("/api/instance/settings/experimental"));
  const connection = getCloudConnection(opts.remoteUrl);
  if (!connection) {
    throw new Error("No cloud connection found. Run `paperclipai cloud connect <remote-url>` first.");
  }

  const discovery = await discoverUpstream(connection.targetOrigin);
  assertDiscoveryCompatible(discovery);
  const bundle = await buildBundleFromLocalCompany({
    localCompanyId,
    connection,
    discovery,
    localApi: ctx.api,
    maxEntitiesPerChunk: opts.maxEntitiesPerChunk,
    mode: opts.dryRun ? "preview" : "apply",
  });
  const coordinator = new LocalUpstreamPushCoordinator({
    targetOrigin: connection.targetOrigin,
    paperclipCompanyId: connection.targetCompanyId,
    headers: ({ method, path }) => cloudProofHeaders(connection, method, path),
  });

  const result = opts.dryRun ? await coordinator.preview(bundle) : await coordinator.apply(bundle);
  const runId = getRunId(result);
  const events = !opts.dryRun && runId ? await coordinator.events(runId).catch(() => null) : null;
  const summary = summarizeResult(result);
  const conflictCount = summary.conflict + summary.staleMapping;

  if (ctx.json) {
    printOutput({ result, events }, { json: true });
  } else {
    console.log(pc.bold(opts.dryRun ? "Cloud Push Preview" : "Cloud Push Applied"));
    console.log(`run=${runId ?? "-"}`);
    console.log(`manifest=${bundle.manifest.manifestHash}`);
    console.log(
      `create=${summary.create} update=${summary.update} adopt=${summary.adopt} ` +
        `skip=${summary.skip} conflict=${summary.conflict} staleMapping=${summary.staleMapping}`,
    );
    printWarnings(result);
    printConflicts(result);
    printEvents(events);
  }

  if (conflictCount > 0) {
    process.exitCode = CLOUD_SYNC_CONFLICT_EXIT_CODE;
  }
  return result;
}

export async function discoverUpstream(remoteUrl: string): Promise<UpstreamDiscovery> {
  const base = new URL(remoteUrl);
  const discoveryUrl = new URL("/.well-known/paperclip-upstream", base);
  return requestCloudJson<UpstreamDiscovery>(discoveryUrl.toString(), { method: "GET" });
}

export function assertDiscoveryCompatible(discovery: UpstreamDiscovery): void {
  if (discovery.schema !== "paperclip-upstream-discovery-v1") {
    throw new Error("Remote URL is not a Paperclip Cloud upstream target.");
  }
  if (discovery.transfer.supportedSchemaMajor !== upstreamTransferSchema.major) {
    throw new Error(
      `Cloud upstream schema mismatch: local major ${upstreamTransferSchema.major}, remote supports ${discovery.transfer.supportedSchemaMajor}.`,
    );
  }
  if (!discovery.transfer.featureFlags?.includes("cloud_sync")) {
    throw new Error("Remote Paperclip Cloud stack does not advertise the cloud_sync transfer flag.");
  }
}

export function resolveDeviceCodeExpiresAt(expiresAt: string | undefined, nowMs = Date.now()): number {
  const parsed = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(parsed) ? parsed : nowMs + DEVICE_CODE_FALLBACK_EXPIRES_MS;
}

export async function buildBundleFromLocalCompany(input: {
  localCompanyId: string;
  connection: CloudConnection;
  discovery: UpstreamDiscovery;
  localApi: {
    post<T>(path: string, body?: unknown): Promise<T | null>;
  };
  maxEntitiesPerChunk?: number;
  mode: "preview" | "apply";
}): Promise<LocalUpstreamExportBundle> {
  const exported = await input.localApi.post<CompanyPortabilityExportResult>(
    `/api/companies/${input.localCompanyId}/export`,
    {
      include: {
        company: true,
        agents: true,
        projects: true,
        issues: true,
        skills: true,
      },
      expandReferencedSkills: true,
    },
  );
  if (!exported) throw new Error("Local company export returned no data.");

  const sourceHash = normalizedContentHash({
    manifest: exported.manifest,
    files: exported.files,
  });
  const source: UpstreamTransferManifestSource = {
    sourceInstanceId: input.connection.sourceInstanceId,
    sourceCompanyId: input.localCompanyId,
    sourceInstanceKeyFingerprint: input.connection.sourceInstanceFingerprint,
    exporterVersion: "paperclipai-cli-cloud-v1",
    sourceSchemaVersion: "paperclip-local-portability-v1",
  };
  const target: UpstreamTransferManifestTarget = {
    targetStackId: input.discovery.stack.id,
    targetCompanyId: input.discovery.stack.companyId,
    targetOrigin: input.discovery.stack.origin,
    supportedSchemaMajor: input.discovery.transfer.supportedSchemaMajor,
  };
  const entities = buildEntitiesFromPortableExport(input.localCompanyId, input.connection.sourceInstanceId, exported);
  const idempotencyKey = [
    input.mode,
    input.connection.sourceInstanceId,
    input.localCompanyId,
    input.discovery.stack.id,
    sourceHash,
  ].join(":");
  return buildLocalUpstreamExportBundle({
    source,
    target,
    runId: `local-${input.mode}-${shortHash(idempotencyKey)}`,
    idempotencyKey,
    entities,
    warnings: exported.warnings.map((message): UpstreamTransferWarning => ({
      code: "local_company_export_warning",
      severity: "warning",
      message,
    })),
    featureFlags: ["cloud_sync"],
    maxEntitiesPerChunk: input.maxEntitiesPerChunk,
  });
}

async function authorizeConnection(
  discovery: UpstreamDiscovery,
  source: ReturnType<typeof createSourceIdentity>,
  opts: { noBrowser: boolean },
): Promise<TokenResponse> {
  if (!opts.noBrowser && canOpenBrowser() && discovery.auth.pkce) {
    try {
      return await authorizeWithBrowser(discovery, source);
    } catch (error) {
      console.error(pc.yellow(`Browser authorization failed; falling back to device-code flow. ${errorMessage(error)}`));
    }
  }
  if (!discovery.auth.deviceCode) {
    throw new Error("Remote Paperclip Cloud stack does not support device-code authorization.");
  }
  return authorizeWithDeviceCode(discovery, source, { openBrowser: !opts.noBrowser && canOpenBrowser() });
}

async function authorizeWithBrowser(
  discovery: UpstreamDiscovery,
  source: ReturnType<typeof createSourceIdentity>,
): Promise<TokenResponse> {
  const pkce = discovery.auth.pkce;
  if (!pkce) throw new Error("Remote did not advertise PKCE authorization.");
  const callback = await startPkceCallbackServer();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomUUID();
  const authorizeUrl = new URL(pkce.authorizeUrl);
  authorizeUrl.searchParams.set("redirectUri", callback.redirectUri);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("codeChallenge", challenge);
  authorizeUrl.searchParams.set("codeChallengeMethod", "S256");
  authorizeUrl.searchParams.set("sourceInstanceId", source.sourceInstanceId);
  authorizeUrl.searchParams.set("sourceInstanceFingerprint", source.sourceInstanceFingerprint);
  authorizeUrl.searchParams.set("sourcePublicKey", source.sourcePublicKey);
  authorizeUrl.searchParams.set("scopes", CLOUD_SYNC_SCOPES.join(" "));

  try {
    console.error(`Open this URL to approve cloud sync:\n${authorizeUrl.toString()}`);
    if (!openUrl(authorizeUrl.toString())) {
      throw new Error("Could not open a browser.");
    }
    const code = await callback.waitForCode(state);
    return requestCloudJson<TokenResponse>(pkce.tokenUrl, {
      method: "POST",
      body: JSON.stringify({
        grantType: "authorization_code",
        code,
        redirectUri: callback.redirectUri,
        codeVerifier: verifier,
      }),
    });
  } finally {
    await callback.close();
  }
}

async function authorizeWithDeviceCode(
  discovery: UpstreamDiscovery,
  source: ReturnType<typeof createSourceIdentity>,
  opts: { openBrowser: boolean },
): Promise<TokenResponse> {
  const device = discovery.auth.deviceCode;
  if (!device) throw new Error("Remote did not advertise device-code authorization.");
  const response = await requestCloudJson<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresAt?: string;
    intervalSeconds?: number;
  }>(device.deviceCodeUrl, {
    method: "POST",
    body: JSON.stringify({
      stackId: discovery.stack.id,
      sourceInstanceId: source.sourceInstanceId,
      sourceInstanceFingerprint: source.sourceInstanceFingerprint,
      sourcePublicKey: source.sourcePublicKey,
      scopes: CLOUD_SYNC_SCOPES,
    }),
  });
  console.error(pc.bold("Cloud device authorization required"));
  console.error(`Open: ${response.verificationUri}`);
  console.error(`Code: ${response.userCode}`);
  if (opts.openBrowser) openUrl(response.verificationUri);

  const expiresAt = resolveDeviceCodeExpiresAt(response.expiresAt);
  const intervalMs = Math.max(500, (response.intervalSeconds ?? 5) * 1000);
  while (Date.now() < expiresAt) {
    await sleep(intervalMs);
    try {
      return await requestCloudJson<TokenResponse>(device.tokenUrl, {
        method: "POST",
        body: JSON.stringify({
          grantType: "device_code",
          deviceCode: response.deviceCode,
        }),
      });
    } catch (error) {
      if (error instanceof CloudAuthRequestError && error.body && typeof error.body === "object") {
        const code = (error.body as { error?: unknown }).error;
        if (code === "authorization_pending") continue;
      }
      throw error;
    }
  }
  throw new Error("Device-code authorization expired before it was approved.");
}

function buildEntitiesFromPortableExport(
  localCompanyId: string,
  sourceInstanceId: string,
  exported: CompanyPortabilityExportResult,
): LocalUpstreamExportEntityInput[] {
  const companyKey: SourceEntityKey = {
    sourceInstanceId,
    sourceCompanyId: localCompanyId,
    sourceEntityType: "company",
    sourceEntityId: localCompanyId,
    sourceNaturalKey: exported.manifest.company?.name ?? localCompanyId,
  };
  const entities: LocalUpstreamExportEntityInput[] = [
    {
      key: companyKey,
      body: {
        kind: "paperclip_company_portability_manifest",
        manifest: exported.manifest,
        rootPath: exported.rootPath,
        paperclipExtensionPath: exported.paperclipExtensionPath,
        fileCount: Object.keys(exported.files).length,
      },
      conflictKeys: [`company:${companyKey.sourceNaturalKey ?? localCompanyId}`],
    },
  ];

  for (const [filePath, entry] of Object.entries(exported.files).sort(([left], [right]) => left.localeCompare(right))) {
    entities.push({
      key: {
        sourceInstanceId,
        sourceCompanyId: localCompanyId,
        sourceEntityType: "company_setting",
        sourceEntityId: shortHash(filePath),
        sourceNaturalKey: filePath,
      },
      body: {
        kind: "paperclip_portable_file",
        path: filePath,
        entry: normalizePortableFileEntry(entry),
      },
      dependencies: [companyKey],
      conflictKeys: [`portable_file:${filePath}`],
    });
  }
  return entities;
}

function normalizePortableFileEntry(entry: CompanyPortabilityFileEntry): Record<string, unknown> {
  if (typeof entry === "string") {
    return { encoding: "utf8", data: entry };
  }
  return { ...entry };
}

async function assertCloudSyncEnabled(settingsPromise: Promise<InstanceExperimentalSettings | null>): Promise<void> {
  const settings = await settingsPromise;
  if (settings?.enableCloudSync !== true) {
    throw new Error(
      "Cloud sync is disabled. Enable the cloud sync experimental setting before running `paperclipai cloud push`.",
    );
  }
}

function cloudProofHeaders(connection: CloudConnection, method: string, pathAndSearch: string): Record<string, string> {
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const payload = [
    method,
    connection.targetHost.toLowerCase(),
    pathAndSearch,
    connection.token.id,
    connection.sourceInstanceId,
    timestamp,
    nonce,
  ].join("\n");
  return {
    Authorization: `Bearer ${connection.accessToken}`,
    "X-Paperclip-Upstream-Source-Instance-Id": connection.sourceInstanceId,
    "X-Paperclip-Upstream-Proof-Timestamp": timestamp,
    "X-Paperclip-Upstream-Proof-Nonce": nonce,
    "X-Paperclip-Upstream-Proof-Signature": sign(
      null,
      Buffer.from(payload, "utf8"),
      connection.privateKeyPem,
    ).toString("base64url"),
  };
}

async function requestCloudJson<T>(url: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  const parsed = text.trim() ? JSON.parse(text) as unknown : {};
  if (!response.ok) {
    const message = typeof parsed === "object" && parsed !== null && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : `Cloud request failed with ${response.status}`;
    throw new CloudAuthRequestError(response.status, message, parsed);
  }
  return parsed as T;
}

function createSourceIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const sourcePublicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
  const sourceInstanceFingerprint = `sha256:${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  return {
    sourceInstanceId: `paperclip-local-${resolvePaperclipInstanceId()}`,
    sourceInstanceFingerprint,
    sourcePublicKey,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

async function startPkceCallbackServer(): Promise<{
  redirectUri: string;
  waitForCode: (state: string) => Promise<string>;
  close: () => Promise<void>;
}> {
  let resolveCode: ((code: string) => void) | null = null;
  let rejectCode: ((error: Error) => void) | null = null;
  let expectedState = "";
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || state !== expectedState) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Paperclip Cloud authorization failed. You can close this tab.");
      rejectCode?.(new Error("Authorization callback was missing a valid code or state."));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Paperclip Cloud authorization complete. You can close this tab.");
    resolveCode?.(code);
  });
  await listenOnLoopback(server);
  const address = server.address();
  if (typeof address !== "object" || !address?.port) {
    throw new Error("Failed to start local authorization callback server.");
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}/cloud/callback`,
    waitForCode: (state: string) => {
      expectedState = state;
      return codePromise;
    },
    close: () => closeServer(server),
  };
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function canOpenBrowser(): boolean {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function summarizeResult(result: unknown): {
  create: number;
  update: number;
  adopt: number;
  skip: number;
  conflict: number;
  staleMapping: number;
} {
  const summary = asRecord(asRecord(result)?.summary);
  return {
    create: numberValue(summary?.create),
    update: numberValue(summary?.update),
    adopt: numberValue(summary?.adopt),
    skip: numberValue(summary?.skip),
    conflict: numberValue(summary?.conflict),
    staleMapping: numberValue(summary?.staleMapping),
  };
}

function printWarnings(result: unknown): void {
  const warnings = Array.isArray(asRecord(result)?.warnings) ? asRecord(result)?.warnings as unknown[] : [];
  for (const warning of warnings) {
    const record = asRecord(warning);
    console.log(pc.yellow(`warning=${record?.code ?? "warning"} ${record?.message ?? ""}`.trim()));
  }
}

function printConflicts(result: unknown): void {
  const conflicts = Array.isArray(asRecord(result)?.conflicts) ? asRecord(result)?.conflicts as unknown[] : [];
  for (const conflict of conflicts.slice(0, 10)) {
    const record = asRecord(conflict);
    console.log(pc.red(`conflict=${record?.conflictKind ?? "target_conflict"} target=${record?.targetEntityId ?? "-"}`));
  }
  if (conflicts.length > 10) console.log(pc.red(`conflicts_truncated=${conflicts.length - 10}`));
}

function printEvents(events: unknown): void {
  const rows = Array.isArray(asRecord(events)?.events) ? asRecord(events)?.events as unknown[] : [];
  for (const row of rows.slice(-10)) {
    const event = asRecord(row);
    console.log(pc.dim(`event=${event?.action ?? "-"} target=${event?.targetEntityId ?? "-"}`));
  }
}

function getRunId(result: unknown): string | null {
  const run = asRecord(asRecord(result)?.run);
  return typeof run?.id === "string" ? run.id : null;
}

function redactConnection(connection: CloudConnection): Record<string, unknown> {
  return {
    id: connection.id,
    remoteUrl: connection.remoteUrl,
    targetOrigin: connection.targetOrigin,
    stackId: connection.stackId,
    targetCompanyId: connection.targetCompanyId,
    scopes: connection.scopes,
    expiresAt: connection.token.expiresAt,
  };
}

function connectionId(targetOrigin: string): string {
  return `cloud-${shortHash(targetOrigin)}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`${label} is required.`);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSchemaMismatchError(error: unknown): boolean {
  if (error instanceof UpstreamImportRequestError) {
    return JSON.stringify(error.body).toLowerCase().includes("schema");
  }
  return error instanceof Error && error.message.toLowerCase().includes("schema mismatch");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const cloudCommandExitCodes = {
  conflict: CLOUD_SYNC_CONFLICT_EXIT_CODE,
  schemaMismatch: CLOUD_SYNC_SCHEMA_MISMATCH_EXIT_CODE,
} as const;
