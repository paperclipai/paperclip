import { createHash } from "node:crypto";

export const upstreamTransferSchema = {
  family: "paperclip-upstream-transfer",
  version: "1.0.0",
  major: 1,
  minor: 0,
} as const;

export type NormalizedSha256 = `sha256:${string}`;

export interface SourceEntityKey {
  sourceInstanceId: string;
  sourceCompanyId: string;
  sourceEntityType: string;
  sourceEntityId: string;
  sourceNaturalKey?: string;
}

export interface UpstreamTransferWarning {
  code: string;
  severity: "info" | "warning" | "blocker";
  message: string;
  entity?: SourceEntityKey;
}

export interface UpstreamTransferEntityRecord {
  key: SourceEntityKey;
  contentHash: NormalizedSha256;
  dependencies: SourceEntityKey[];
  warnings: UpstreamTransferWarning[];
}

export interface UpstreamTransferManifestSource {
  sourceInstanceId: string;
  sourceCompanyId: string;
  sourceInstanceKeyFingerprint: string;
  exporterVersion: string;
  sourceSchemaVersion: string;
}

export interface UpstreamTransferManifestTarget {
  targetStackId: string;
  targetCompanyId: string;
  targetOrigin: string;
  supportedSchemaMajor: number;
}

export interface UpstreamTransferChunk {
  chunkIndex: number;
  totalChunks: number;
  byteLength: number;
  sha256: NormalizedSha256;
  manifestHash: NormalizedSha256;
}

export interface UpstreamTransferManifest {
  schema: typeof upstreamTransferSchema;
  source: UpstreamTransferManifestSource;
  target: UpstreamTransferManifestTarget;
  runId: string;
  idempotencyKey: string;
  generatedAt: string;
  entityCount: number;
  entities: UpstreamTransferEntityRecord[];
  chunks: UpstreamTransferChunk[];
  warnings: UpstreamTransferWarning[];
  featureFlags: string[];
  manifestHash: NormalizedSha256;
}

export interface LocalUpstreamExportEntityInput {
  key: SourceEntityKey;
  body: Record<string, unknown>;
  dependencies?: SourceEntityKey[];
  warnings?: UpstreamTransferWarning[];
  conflictKeys?: string[];
}

export interface LocalUpstreamExportEntity {
  record: UpstreamTransferEntityRecord;
  body: Record<string, unknown>;
  conflictKeys?: string[];
}

export interface LocalUpstreamExportChunk {
  chunkIndex: number;
  totalChunks: number;
  byteLength: number;
  sha256: NormalizedSha256;
  payload: {
    entityKeys: SourceEntityKey[];
  };
}

export interface LocalUpstreamExportBundle {
  manifest: UpstreamTransferManifest;
  entities: LocalUpstreamExportEntity[];
  chunks: LocalUpstreamExportChunk[];
}

export interface BuildLocalUpstreamExportBundleInput {
  source: UpstreamTransferManifestSource;
  target: UpstreamTransferManifestTarget;
  runId: string;
  idempotencyKey: string;
  entities: LocalUpstreamExportEntityInput[];
  warnings?: UpstreamTransferWarning[];
  featureFlags?: string[];
  maxEntitiesPerChunk?: number;
}

export interface LocalUpstreamPushCoordinatorOptions {
  targetOrigin: string;
  paperclipCompanyId: string;
  fetch?: typeof fetch;
  headers?: (input: { method: string; path: string }) => HeadersInit | Promise<HeadersInit>;
}

export class UpstreamImportRequestError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class LocalUpstreamPushCoordinator {
  readonly #targetOrigin: string;
  readonly #paperclipCompanyId: string;
  readonly #fetch: typeof fetch;
  readonly #headers: NonNullable<LocalUpstreamPushCoordinatorOptions["headers"]>;

  constructor(options: LocalUpstreamPushCoordinatorOptions) {
    this.#targetOrigin = options.targetOrigin.replace(/\/+$/u, "");
    this.#paperclipCompanyId = options.paperclipCompanyId;
    this.#fetch = options.fetch ?? fetch;
    this.#headers = options.headers ?? (() => ({}));
  }

  async preview(bundle: LocalUpstreamExportBundle): Promise<unknown> {
    return this.post(`/api/companies/${encodeURIComponent(this.#paperclipCompanyId)}/upstream-imports/preview`, {
      manifest: bundle.manifest,
      entities: bundle.entities,
    });
  }

  async apply(bundle: LocalUpstreamExportBundle): Promise<unknown> {
    const run = await this.post(`/api/companies/${encodeURIComponent(this.#paperclipCompanyId)}/upstream-imports/runs`, {
      mode: "apply",
      manifest: bundle.manifest,
      entities: bundle.entities,
    }) as { run?: { id?: unknown } };
    const runId = typeof run.run?.id === "string" ? run.run.id : undefined;
    if (!runId) {
      throw new Error("Remote upstream importer did not return a run id");
    }

    for (const chunk of bundle.chunks) {
      await this.post(`/api/upstream-import-runs/${encodeURIComponent(runId)}/chunks`, chunk);
    }

    return this.post(`/api/upstream-import-runs/${encodeURIComponent(runId)}/apply`, {});
  }

  async events(runId: string): Promise<unknown> {
    return this.get(`/api/upstream-import-runs/${encodeURIComponent(runId)}/events`);
  }

  private async get(path: string): Promise<unknown> {
    const response = await this.#fetch(`${this.#targetOrigin}${path}`, {
      method: "GET",
      headers: await this.#headers({ method: "GET", path }),
    });
    return parseCoordinatorResponse(response);
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.#fetch(`${this.#targetOrigin}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await this.#headers({ method: "POST", path })),
      },
      body: JSON.stringify(body),
    });
    return parseCoordinatorResponse(response);
  }
}

export function buildLocalUpstreamExportBundle(
  input: BuildLocalUpstreamExportBundleInput,
): LocalUpstreamExportBundle {
  const entities = input.entities.map<LocalUpstreamExportEntity>((entity) => ({
    record: {
      key: entity.key,
      contentHash: normalizedContentHash(entity.body),
      dependencies: entity.dependencies ?? [],
      warnings: entity.warnings ?? [],
    },
    body: entity.body,
    conflictKeys: entity.conflictKeys,
  }));
  const chunks = buildLocalChunks(entities, input.maxEntitiesPerChunk ?? 100);
  const manifestWithoutHash = {
    schema: upstreamTransferSchema,
    source: input.source,
    target: input.target,
    runId: input.runId,
    idempotencyKey: input.idempotencyKey,
    generatedAt: new Date(0).toISOString(),
    entityCount: entities.length,
    entities: entities.map((entity) => entity.record),
    chunks: chunks.map(({ payload: _payload, ...chunk }) => chunk),
    warnings: input.warnings ?? [],
    featureFlags: (input.featureFlags ?? ["cloud_sync"]).slice().sort(),
  };
  const manifestHash = normalizedContentHash(manifestWithoutHash);
  return {
    manifest: {
      ...manifestWithoutHash,
      chunks: manifestWithoutHash.chunks.map((chunk) => ({ ...chunk, manifestHash })),
      manifestHash,
    },
    entities,
    chunks,
  };
}

export function normalizedContentHash(value: unknown): NormalizedSha256 {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function buildLocalChunks(
  entities: LocalUpstreamExportEntity[],
  maxEntitiesPerChunk: number,
): LocalUpstreamExportChunk[] {
  if (!Number.isInteger(maxEntitiesPerChunk) || maxEntitiesPerChunk < 1) {
    throw new Error("maxEntitiesPerChunk must be a positive integer");
  }
  if (entities.length === 0) return [];

  const groups: LocalUpstreamExportEntity[][] = [];
  for (let index = 0; index < entities.length; index += maxEntitiesPerChunk) {
    groups.push(entities.slice(index, index + maxEntitiesPerChunk));
  }

  return groups.map((group, index) => {
    const payload = {
      entityKeys: group.map((entity) => entity.record.key),
    };
    return {
      chunkIndex: index,
      totalChunks: groups.length,
      byteLength: Buffer.byteLength(canonicalJson(payload)),
      sha256: normalizedContentHash(payload),
      payload,
    };
  });
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

async function parseCoordinatorResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const parsed = text.trim() ? safeParseJson(text) : {};
  if (!response.ok) {
    const message = typeof parsed === "object" && parsed !== null && "error" in parsed
      ? String((parsed as { error: unknown }).error)
      : `Upstream importer request failed with ${response.status}`;
    throw new UpstreamImportRequestError(response.status, message, parsed);
  }
  return parsed;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
