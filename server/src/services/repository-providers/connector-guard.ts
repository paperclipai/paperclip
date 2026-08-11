import {
  REPOSITORY_PROVIDER_ANY_HOST,
  normalizeRepositoryProviderHost,
} from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";
import {
  sanitizeRepositoryProviderError,
  sanitizeRepositoryProviderMetadata,
} from "../repository-normalization.js";
import type {
  BeginInstallationResult,
  CompleteInstallationResult,
  DiscoverResult,
  DiscoveredRepository,
  ProviderRepositorySnapshot,
  RepositoryProviderConnector,
  ResolveCloneCredentialInput,
  ResolveCloneCredentialResult,
} from "./provider-contract.js";

/**
 * Hardening layer applied to every registered repository provider connector.
 *
 * A connector is an *input boundary*: whether it is a bundled provider or an
 * out-of-process extension, everything it returns is untrusted until proven
 * otherwise. This wrapper is the single place that:
 *
 * - re-validates shapes and drops entries that do not conform, rather than
 *   letting a malformed row reach persistence;
 * - strips secret-looking metadata keys and sanitizes error text before it can
 *   reach a row, a log line, or an API response;
 * - keeps connector identity honest — a connector cannot claim another host;
 * - marks the transient clone credential no-store so serializing the result
 *   (logs, portability output, prompts) cannot leak the token;
 * - fails closed: an unexpected throw becomes a sanitized `unprocessable`.
 */

const MAX_DISCOVERY_ITEMS = 500;
const MAX_SYNC_REPOSITORIES = 5_000;

/** Marker for a value that must never be persisted, logged, or exported. */
export const NO_STORE_MARKER = "__paperclipNoStore" as const;

export interface GuardedCloneCredential extends ResolveCloneCredentialResult {
  /** Always true: this value is transient and must not be stored. */
  readonly [NO_STORE_MARKER]: true;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw unprocessable(`Repository provider returned an invalid ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requireFutureDate(value: unknown, field: string): Date {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) {
    throw unprocessable(`Repository provider returned an invalid ${field}`);
  }
  if (date.getTime() <= Date.now()) {
    throw unprocessable(`Repository provider returned an already-expired ${field}`);
  }
  return date;
}

function requireHttpsUrl(value: unknown, field: string): string {
  const raw = requireString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw unprocessable(`Repository provider returned an invalid ${field}`);
  }
  if (parsed.protocol !== "https:") {
    throw unprocessable(`Repository provider ${field} must use HTTPS`);
  }
  return raw;
}

function sanitizeDiscoveredRepository(value: unknown): DiscoveredRepository | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<DiscoveredRepository>;
  if (
    typeof item.providerRepositoryId !== "string" || item.providerRepositoryId.length === 0
    || typeof item.owner !== "string" || item.owner.length === 0
    || typeof item.name !== "string" || item.name.length === 0
    || typeof item.cloneUrl !== "string" || item.cloneUrl.length === 0
  ) {
    return null;
  }
  return {
    providerRepositoryId: item.providerRepositoryId,
    owner: item.owner,
    name: item.name,
    cloneUrl: item.cloneUrl,
    webUrl: optionalString(item.webUrl),
    defaultBranch: optionalString(item.defaultBranch),
    visibility: item.visibility,
    archived: item.archived === true,
    metadata: sanitizeRepositoryProviderMetadata(item.metadata),
  };
}

function sanitizeSnapshot(value: unknown): ProviderRepositorySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Partial<ProviderRepositorySnapshot>;
  if (
    typeof snapshot.providerRepositoryId !== "string" || snapshot.providerRepositoryId.length === 0
    || typeof snapshot.cloneUrl !== "string" || snapshot.cloneUrl.length === 0
  ) {
    return null;
  }
  return {
    ...snapshot,
    providerRepositoryId: snapshot.providerRepositoryId,
    cloneUrl: snapshot.cloneUrl,
    providerMetadata: sanitizeRepositoryProviderMetadata(snapshot.providerMetadata),
  } as ProviderRepositorySnapshot;
}

/**
 * Wraps a resolved credential so serializing it cannot leak the token.
 *
 * The token stays readable as a property (the clone-credential endpoint and
 * the git transport need it) but `toJSON` — used by `JSON.stringify`, the
 * logger, portability export, and prompt rendering — returns a redacted view.
 */
export function markCloneCredentialNoStore(
  result: ResolveCloneCredentialResult,
): GuardedCloneCredential {
  const guarded = {
    ...result,
    [NO_STORE_MARKER]: true as const,
  };
  Object.defineProperty(guarded, "toJSON", {
    enumerable: false,
    value: () => ({
      username: result.username,
      token: "[redacted]",
      authenticatedCloneUrl: "[redacted]",
      expiresAt: result.expiresAt,
      audit: result.audit,
      [NO_STORE_MARKER]: true,
    }),
  });
  return guarded as GuardedCloneCredential;
}

export function isNoStoreCloneCredential(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>)[NO_STORE_MARKER] === true);
}

async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // Providers surface HTTP-shaped errors deliberately (422 for bad state,
    // 409 for conflicts); those pass through with their status intact. Anything
    // else becomes a sanitized 422 so a raw provider message — which may embed a
    // token or an internal URL — never reaches a caller or a log line.
    if (error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number") {
      throw error;
    }
    throw unprocessable(sanitizeRepositoryProviderError(error));
  }
}

export interface GuardConnectorOptions {
  /**
   * Identity the connector is allowed to answer for. Results claiming another
   * host are rejected rather than silently rewritten, because a mismatch means
   * the connector and the host disagree about which install is being talked to.
   */
  provider: string;
  host: string;
}

/**
 * Returns a connector that enforces the contract on everything the underlying
 * implementation returns.
 */
export function guardRepositoryProviderConnector(
  connector: RepositoryProviderConnector,
  options: GuardConnectorOptions,
): RepositoryProviderConnector {
  const provider = options.provider;
  const host = options.host;

  function assertHost(claimed: unknown, field: string): string {
    if (host === REPOSITORY_PROVIDER_ANY_HOST) {
      const normalized = normalizeRepositoryProviderHost(claimed);
      if (!normalized) throw unprocessable(`Repository provider returned an invalid ${field}`);
      return normalized;
    }
    const normalized = normalizeRepositoryProviderHost(claimed);
    if (normalized !== host) {
      throw unprocessable(`Repository provider returned a ${field} outside its registered identity`);
    }
    return normalized;
  }

  return {
    provider,
    host,

    async beginInstallation(input): Promise<BeginInstallationResult> {
      return await guarded(async () => {
        const result = await connector.beginInstallation(input);
        return {
          installUrl: requireHttpsUrl(result?.installUrl, "install URL"),
          state: requireString(result?.state, "installation state"),
          expiresAt: requireFutureDate(result?.expiresAt, "installation state expiry"),
        };
      });
    },

    async completeInstallation(input): Promise<CompleteInstallationResult> {
      return await guarded(async () => {
        const result = await connector.completeInstallation(input);
        // Company binding is decided by the host, not reported by the provider:
        // a provider that echoes a different company is refused outright.
        if (result?.companyId !== input.companyId) {
          throw unprocessable("Repository provider returned a company outside the requested scope");
        }
        return {
          companyId: input.companyId,
          userId: requireString(result?.userId, "installation user"),
          installationId: requireString(result?.installationId, "installation id"),
          accountId: optionalString(result?.accountId),
          accountName: optionalString(result?.accountName),
          host: assertHost(result?.host, "host"),
          providerMetadata: sanitizeRepositoryProviderMetadata(result?.providerMetadata),
        };
      });
    },

    async discover(input): Promise<DiscoverResult> {
      return await guarded(async () => {
        const result = await connector.discover(input);
        const items = Array.isArray(result?.items) ? result.items : [];
        if (items.length > MAX_DISCOVERY_ITEMS) {
          throw unprocessable("Repository provider returned an oversized discovery page");
        }
        return {
          items: items.map(sanitizeDiscoveredRepository).filter((item): item is DiscoveredRepository => item != null),
          nextCursor: optionalString(result?.nextCursor),
          total: typeof result?.total === "number" && Number.isFinite(result.total) ? result.total : null,
        };
      });
    },

    async refreshMetadata(input): Promise<ProviderRepositorySnapshot | null> {
      return await guarded(async () => {
        const result = await connector.refreshMetadata(input);
        return result == null ? null : sanitizeSnapshot(result);
      });
    },

    async sync(input) {
      return await guarded(async () => {
        const result = await connector.sync(input);
        const repositories = Array.isArray(result?.repositories) ? result.repositories : [];
        if (repositories.length > MAX_SYNC_REPOSITORIES) {
          throw unprocessable("Repository provider returned an oversized sync page");
        }
        return {
          repositories: repositories
            .map(sanitizeSnapshot)
            .filter((snapshot): snapshot is ProviderRepositorySnapshot => snapshot != null),
          cursor: optionalString(result?.cursor),
        };
      });
    },

    async disconnect(input) {
      if (!connector.disconnect) return;
      await guarded(async () => {
        await connector.disconnect!(input);
      });
    },

    async resolveCloneCredential(input: ResolveCloneCredentialInput): Promise<ResolveCloneCredentialResult> {
      return await guarded(async () => {
        const result = await connector.resolveCloneCredential(input);
        const expiresAt = requireFutureDate(result?.expiresAt, "clone credential expiry");
        const token = requireString(result?.token, "clone credential token");
        const authenticatedCloneUrl = requireString(result?.authenticatedCloneUrl, "authenticated clone URL");
        if (!authenticatedCloneUrl.includes(token)) {
          throw unprocessable("Repository provider returned a clone URL missing its credential");
        }
        // The audit line is rebuilt from host-known values so a provider cannot
        // attribute its credential use to another connection or company.
        return markCloneCredentialNoStore({
          username: requireString(result?.username, "clone credential username"),
          token,
          authenticatedCloneUrl,
          expiresAt,
          audit: {
            provider,
            host,
            connectionId: input.connection.id,
            repositoryId: input.repository.id,
            installationId: optionalString(result?.audit?.installationId) ?? input.connection.installationId,
            expiresAt,
          },
        });
      });
    },
  };
}
