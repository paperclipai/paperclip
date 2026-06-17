import type { MemoryBindingConfig } from "@paperclipai/db";

export type { MemoryBindingConfig };

/**
 * V1 subset of the memory contract from
 * doc/plans/2026-03-17-memory-service-surface-api.md, scoped to the gbrain
 * provider (doc/plans/2026-06-10-gbrain-memory-control-plane.md).
 */

export const MEMORY_BINDING_CONFIG_DEFAULTS = {
  queryTimeoutMs: 4_000,
  captureTimeoutMs: 15_000,
  topK: 5,
  hydrateEnabled: true,
  captureRunsEnabled: true,
  maxSnippetChars: 600,
  maxBundleChars: 4_000,
} as const;

export interface ResolvedMemoryBindingConfig {
  binPath: string | null;
  queryTimeoutMs: number;
  captureTimeoutMs: number;
  topK: number;
  hydrateEnabled: boolean;
  captureRunsEnabled: boolean;
  maxSnippetChars: number;
  maxBundleChars: number;
}

export function resolveMemoryBindingConfig(
  config: MemoryBindingConfig | null | undefined,
): ResolvedMemoryBindingConfig {
  const defaults = MEMORY_BINDING_CONFIG_DEFAULTS;
  return {
    binPath: typeof config?.binPath === "string" && config.binPath.length > 0 ? config.binPath : null,
    queryTimeoutMs: readPositiveInt(config?.queryTimeoutMs) ?? defaults.queryTimeoutMs,
    captureTimeoutMs: readPositiveInt(config?.captureTimeoutMs) ?? defaults.captureTimeoutMs,
    topK: readPositiveInt(config?.topK) ?? defaults.topK,
    hydrateEnabled: config?.hydrateEnabled ?? defaults.hydrateEnabled,
    captureRunsEnabled: config?.captureRunsEnabled ?? defaults.captureRunsEnabled,
    maxSnippetChars: readPositiveInt(config?.maxSnippetChars) ?? defaults.maxSnippetChars,
    maxBundleChars: readPositiveInt(config?.maxBundleChars) ?? defaults.maxBundleChars,
  };
}

function readPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  return truncated > 0 ? truncated : null;
}

export interface MemoryScope {
  companyId: string;
  agentId?: string;
  projectId?: string;
  issueId?: string;
  runId?: string;
}

export interface MemorySourceRef {
  kind:
    | "issue_comment"
    | "issue_document"
    | "issue"
    | "run"
    | "activity"
    | "manual_note"
    | "external_document";
  companyId: string;
  issueId?: string;
  commentId?: string;
  documentKey?: string;
  runId?: string;
  activityId?: string;
  externalRef?: string;
}

export interface MemorySnippet {
  slug: string;
  text: string;
  title?: string | null;
  score?: number | null;
  stale?: boolean;
  source?: MemorySourceRef;
}

export interface MemoryContextBundle {
  snippets: MemorySnippet[];
}

export type MemoryProviderErrorCode = "unavailable" | "timeout" | "exec_failed" | "bad_output";

/**
 * Provider calls never throw past the provider boundary; every failure is a
 * typed error result so the service can write failed memory_operations rows.
 */
export type MemoryProviderResult<T> =
  | { ok: true; value: T; latencyMs: number }
  | { ok: false; errorCode: MemoryProviderErrorCode; errorMessage: string; latencyMs: number };

export interface MemoryProviderQueryRequest {
  companyId: string;
  query: string;
  topK?: number;
  timeoutMs?: number;
}

export interface MemoryProviderCaptureRequest {
  companyId: string;
  slug: string;
  content: string;
  type?: string;
  tags?: string[];
  timeoutMs?: number;
}

export interface MemoryPage {
  slug: string;
  title?: string | null;
  content?: string | null;
}

export interface MemoryProvider {
  key: string;
  isAvailable(): Promise<boolean>;
  query(req: MemoryProviderQueryRequest): Promise<MemoryProviderResult<MemoryContextBundle>>;
  capture(req: MemoryProviderCaptureRequest): Promise<MemoryProviderResult<{ slug: string }>>;
  get(slug: string, opts?: { companyId?: string; timeoutMs?: number }): Promise<MemoryProviderResult<MemoryPage>>;
  forget(slug: string, opts?: { companyId?: string; timeoutMs?: number }): Promise<MemoryProviderResult<{ slug: string }>>;
}
