import { randomUUID } from "node:crypto";
import type { RepositoryConnection, RepositoryVisibility } from "@paperclipai/shared";
import { conflict, unprocessable } from "../../errors.js";
import type { ProviderRepositorySnapshot } from "../repositories.js";
import {
  normalizeRepositoryLocator,
  sanitizeRepositoryProviderMetadata,
} from "../repository-normalization.js";
import {
  signConnectionState,
  verifyConnectionState,
} from "./connection-state.js";
import type {
  BeginInstallationInput,
  BeginInstallationResult,
  CompleteInstallationInput,
  CompleteInstallationResult,
  DiscoverInput,
  DiscoverResult,
  DiscoveredRepository,
  RefreshMetadataInput,
  RepositoryProviderConnector,
  ResolveCloneCredentialInput,
  ResolveCloneCredentialResult,
} from "./provider-contract.js";

export const GITHUB_PROVIDER = "github";
export const GITHUB_DEFAULT_HOST = "github.com";
const DISCOVERY_DEFAULT_PAGE_SIZE = 30;
const DISCOVERY_MAX_PAGE_SIZE = 100;
const STATE_TTL_MS = 10 * 60 * 1000;

/** Raw GitHub repository shape (only the fields we consume). */
export interface GitHubRepository {
  id: number | string;
  name: string;
  full_name: string;
  owner: { login: string; id?: number | string; type?: string };
  clone_url: string;
  html_url?: string;
  default_branch?: string | null;
  private?: boolean;
  visibility?: string | null;
  archived?: boolean;
  fork?: boolean;
}

export interface GitHubInstallation {
  id: number | string;
  account: { id?: number | string; login: string; type?: string; html_url?: string } | null;
  app_slug?: string;
  target_type?: string;
  repository_selection?: string;
}

export interface GitHubInstallationToken {
  token: string;
  expiresAt: Date;
}

/**
 * Injectable transport that isolates all GitHub App authentication (App JWT
 * minting, installation-token exchange) and HTTP access behind a small surface.
 * The real transport holds the app private key; tests inject a fake. The
 * private key/token never cross back into the provider's persisted output.
 */
export interface GitHubAppTransport {
  readonly host: string;
  readonly apiBaseUrl: string;
  getInstallation(installationId: string): Promise<GitHubInstallation | null>;
  createInstallationAccessToken(installationId: string): Promise<GitHubInstallationToken>;
  listRepositories(input: {
    installationId: string;
    page: number;
    perPage: number;
    query?: string | null;
  }): Promise<{ totalCount: number | null; items: GitHubRepository[] }>;
  getRepository(input: {
    installationId: string;
    providerRepositoryId: string;
  }): Promise<GitHubRepository | null>;
}

export interface GitHubProviderConfig {
  /** App slug used to build the install URL (github.com/apps/<slug>/installations/new). */
  appSlug: string;
  /** Secret used to sign expiring connection state. Never persisted. */
  stateSecret: string;
}

export interface GitHubProviderDeps {
  transport: GitHubAppTransport;
  config: GitHubProviderConfig;
  clock?: () => Date;
  nonce?: () => string;
}

function mapVisibility(repo: GitHubRepository): RepositoryVisibility {
  if (repo.visibility === "public" || repo.visibility === "private" || repo.visibility === "internal") {
    return repo.visibility;
  }
  if (repo.private === true) return "private";
  if (repo.private === false) return "public";
  return "unknown";
}

function toSnapshot(repo: GitHubRepository): ProviderRepositorySnapshot {
  const metadata = sanitizeRepositoryProviderMetadata({
    full_name: repo.full_name,
    owner: repo.owner?.login ?? null,
    owner_type: repo.owner?.type ?? null,
    archived: repo.archived ?? false,
    fork: repo.fork ?? false,
  });
  return {
    providerRepositoryId: String(repo.id),
    cloneUrl: repo.clone_url,
    webUrl: repo.html_url ?? null,
    defaultBranch: repo.default_branch ?? null,
    visibility: mapVisibility(repo),
    // A repository archived on the provider stays importable but is surfaced as
    // unavailable so operators see it cannot be worked on without unarchiving.
    state: repo.archived ? "unavailable" : "active",
    unavailableReason: repo.archived ? "Repository is archived on GitHub" : null,
    providerMetadata: metadata,
  };
}

function toDiscovered(repo: GitHubRepository): DiscoveredRepository {
  const normalized = normalizeRepositoryLocator(repo.clone_url);
  return {
    providerRepositoryId: String(repo.id),
    owner: normalized.owner,
    name: normalized.name,
    cloneUrl: normalized.cloneUrl,
    webUrl: repo.html_url ?? normalized.webUrl,
    defaultBranch: repo.default_branch ?? null,
    visibility: mapVisibility(repo),
    archived: repo.archived ?? false,
    metadata: sanitizeRepositoryProviderMetadata({
      full_name: repo.full_name,
      owner: repo.owner?.login ?? null,
      fork: repo.fork ?? false,
    }),
  };
}

function clampPageSize(pageSize: number | undefined): number {
  if (!pageSize || !Number.isFinite(pageSize)) return DISCOVERY_DEFAULT_PAGE_SIZE;
  return Math.min(DISCOVERY_MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
}

function parseCursor(cursor: string | null | undefined): number {
  if (!cursor) return 1;
  const page = Number.parseInt(cursor, 10);
  if (!Number.isFinite(page) || page < 1) throw unprocessable("Discovery cursor is invalid");
  return page;
}

function requireInstallationId(connection: RepositoryConnection): string {
  if (!connection.installationId) throw unprocessable("GitHub connection is missing an installation id");
  return connection.installationId;
}

export function createGitHubProvider(deps: GitHubProviderDeps): RepositoryProviderConnector {
  const clock = deps.clock ?? (() => new Date());
  const nonce = deps.nonce ?? (() => randomUUID());
  const host = deps.transport.host.toLowerCase();

  return {
    provider: GITHUB_PROVIDER,
    host,

    async beginInstallation(input: BeginInstallationInput): Promise<BeginInstallationResult> {
      if (!input.companyId || !input.userId) throw unprocessable("Installation requires a company and user");
      const { state, payload } = signConnectionState({
        companyId: input.companyId,
        userId: input.userId,
        provider: GITHUB_PROVIDER,
        redirectPath: input.redirectPath ?? null,
        secret: deps.config.stateSecret,
        ttlMs: STATE_TTL_MS,
        nonce: nonce(),
        now: clock(),
      });
      const installUrl = `https://${host}/apps/${encodeURIComponent(deps.config.appSlug)}/installations/new?state=${encodeURIComponent(state)}`;
      return { installUrl, state, expiresAt: new Date(payload.exp) };
    },

    async completeInstallation(input: CompleteInstallationInput): Promise<CompleteInstallationResult> {
      const payload = verifyConnectionState({
        state: input.state,
        provider: GITHUB_PROVIDER,
        secret: deps.config.stateSecret,
        now: clock(),
      });
      if (payload.companyId !== input.companyId) {
        throw conflict("Connection state does not match the completing company");
      }
      if (!input.installationId) throw unprocessable("Installation callback is missing an installation id");
      const installation = await deps.transport.getInstallation(input.installationId);
      if (!installation) throw unprocessable("GitHub installation was not found");
      return {
        companyId: payload.companyId,
        userId: payload.userId,
        installationId: String(installation.id),
        accountId: installation.account?.id != null ? String(installation.account.id) : null,
        accountName: installation.account?.login ?? null,
        host,
        providerMetadata: sanitizeRepositoryProviderMetadata({
          account_login: installation.account?.login ?? null,
          account_type: installation.account?.type ?? null,
          app_slug: installation.app_slug ?? deps.config.appSlug,
          target_type: installation.target_type ?? null,
          repository_selection: installation.repository_selection ?? null,
        }),
      };
    },

    async discover(input: DiscoverInput): Promise<DiscoverResult> {
      const installationId = requireInstallationId(input.connection);
      const perPage = clampPageSize(input.pageSize);
      const page = parseCursor(input.cursor);
      const result = await deps.transport.listRepositories({
        installationId,
        page,
        perPage,
        query: input.query?.trim() || null,
      });
      const items = result.items.map(toDiscovered);
      const hasNextPage = result.totalCount !== null
        ? page * perPage < result.totalCount
        : items.length === perPage;
      const nextCursor = hasNextPage ? String(page + 1) : null;
      return { items, nextCursor, total: result.totalCount };
    },

    async refreshMetadata(input: RefreshMetadataInput): Promise<ProviderRepositorySnapshot | null> {
      const installationId = requireInstallationId(input.connection);
      const repo = await deps.transport.getRepository({
        installationId,
        providerRepositoryId: input.providerRepositoryId,
      });
      return repo ? toSnapshot(repo) : null;
    },

    async sync(input: {
      connection: RepositoryConnection;
      cursor: string | null;
    }): Promise<{ repositories: ProviderRepositorySnapshot[]; cursor?: string | null }> {
      const installationId = requireInstallationId(input.connection);
      const repositories: ProviderRepositorySnapshot[] = [];
      let page = 1;
      // Walk every installation page so rename/transfer (stable provider id,
      // changed owner/name) and newly granted repositories converge idempotently.
      for (;;) {
        const result = await deps.transport.listRepositories({
          installationId,
          page,
          perPage: DISCOVERY_MAX_PAGE_SIZE,
          query: null,
        });
        for (const repo of result.items) repositories.push(toSnapshot(repo));
        if (result.items.length < DISCOVERY_MAX_PAGE_SIZE) break;
        page += 1;
      }
      return { repositories, cursor: null };
    },

    async resolveCloneCredential(input: ResolveCloneCredentialInput): Promise<ResolveCloneCredentialResult> {
      const installationId = requireInstallationId(input.connection);
      const minted = await deps.transport.createInstallationAccessToken(installationId);
      const username = "x-access-token";
      const authenticatedCloneUrl = `https://${username}:${minted.token}@${input.repository.host}/${input.repository.owner}/${input.repository.name}.git`;
      return {
        username,
        token: minted.token,
        authenticatedCloneUrl,
        expiresAt: minted.expiresAt,
        audit: {
          provider: GITHUB_PROVIDER,
          host,
          connectionId: input.connection.id,
          repositoryId: input.repository.id,
          installationId,
          expiresAt: minted.expiresAt,
        },
      };
    },

    async disconnect(): Promise<void> {
      // GitHub App installations are revoked on GitHub's side; there is no
      // server-side token to invalidate because none is ever persisted. The
      // connection service marks repositories unavailable transactionally.
    },
  };
}
