import type { RepositoryConnection, RepositoryVisibility } from "@paperclipai/shared";
import type { ProviderRepositorySnapshot } from "../repositories.js";
import type { RepositoryProviderAdapter } from "../repository-connections.js";

/**
 * First-class repository provider contract.
 *
 * Foundation ([PAP-17065]) defined the minimal {@link RepositoryProviderAdapter}
 * (`sync`/`disconnect`) that the connection service drives. This module extends
 * that contract with the seams the GitHub.com connection/discovery path needs:
 * installation lifecycle, searchable paginated discovery, metadata refresh, and
 * short-lived clone credential resolution.
 *
 * The extended surface is intentionally provider-agnostic so the fake provider
 * used by the conformance harness and the real GitHub.com provider share the
 * exact same shape. Credentials, provider tokens, and app/private keys never
 * appear on any persisted row — they only flow through the transient results of
 * {@link RepositoryProviderConnector.resolveCloneCredential}.
 */

/** A repository as surfaced by provider discovery, before it is imported. */
export interface DiscoveredRepository {
  /** Stable provider-scoped id (survives rename/transfer). */
  providerRepositoryId: string;
  owner: string;
  name: string;
  cloneUrl: string;
  webUrl?: string | null;
  defaultBranch?: string | null;
  visibility?: RepositoryVisibility;
  /** True when the repository is archived on the provider. */
  archived?: boolean;
  /** Sanitized, secret-free provider metadata for display. */
  metadata?: Record<string, unknown> | null;
}

export interface DiscoverInput {
  connection: RepositoryConnection;
  /** Free-text filter over owner/name; provider decides matching semantics. */
  query?: string | null;
  /** Opaque pagination cursor returned by a previous page. */
  cursor?: string | null;
  /** Requested page size; providers may clamp. */
  pageSize?: number;
}

export interface DiscoverResult {
  items: DiscoveredRepository[];
  /** Opaque cursor for the next page, or null when the last page is reached. */
  nextCursor: string | null;
  /** Total matches when the provider can report it, else null. */
  total: number | null;
}

export interface BeginInstallationInput {
  companyId: string;
  /** User initiating the connection; bound into the signed state. */
  userId: string;
  /** Optional app-relative path to return to after the provider callback. */
  redirectPath?: string | null;
}

export interface BeginInstallationResult {
  /** Provider URL the operator visits to authorize/install the app. */
  installUrl: string;
  /** Signed, expiring state bound to company/user. */
  state: string;
  /** When the signed state stops being valid. */
  expiresAt: Date;
}

export interface CompleteInstallationInput {
  /** Signed state echoed back by the provider callback. */
  state: string;
  /** Installation id reported by the provider callback. */
  installationId: string;
  /** Company the caller believes it is completing for (defense in depth). */
  companyId: string;
}

export interface CompleteInstallationResult {
  companyId: string;
  userId: string;
  installationId: string;
  accountId: string | null;
  accountName: string | null;
  host: string;
  /** Sanitized installation/account metadata for the connection row. */
  providerMetadata: Record<string, unknown> | null;
}

export interface RefreshMetadataInput {
  connection: RepositoryConnection;
  providerRepositoryId: string;
}

export interface ResolveCloneCredentialInput {
  connection: RepositoryConnection;
  repository: {
    id: string;
    providerRepositoryId: string | null;
    owner: string;
    name: string;
    cloneUrl: string;
    host: string;
  };
}

/**
 * Result of resolving a short-lived clone credential. The `token` is transient
 * and MUST NOT be persisted or logged. `audit` carries only secret-free fields
 * safe to write to the activity log.
 */
export interface ResolveCloneCredentialResult {
  username: string;
  token: string;
  /** Clone URL with the transient credential embedded. Never persist. */
  authenticatedCloneUrl: string;
  expiresAt: Date;
  audit: {
    provider: string;
    host: string;
    connectionId: string;
    repositoryId: string;
    installationId: string | null;
    expiresAt: Date;
  };
}

/**
 * The full provider connector contract. Extends the Foundation adapter so a
 * connector can be registered directly with `repositoryProviderRegistry`.
 */
export interface RepositoryProviderConnector extends RepositoryProviderAdapter {
  readonly provider: string;
  readonly host: string;

  beginInstallation(input: BeginInstallationInput): Promise<BeginInstallationResult>;
  completeInstallation(input: CompleteInstallationInput): Promise<CompleteInstallationResult>;

  discover(input: DiscoverInput): Promise<DiscoverResult>;
  refreshMetadata(input: RefreshMetadataInput): Promise<ProviderRepositorySnapshot | null>;

  resolveCloneCredential(input: ResolveCloneCredentialInput): Promise<ResolveCloneCredentialResult>;
}

export type { ProviderRepositorySnapshot };
