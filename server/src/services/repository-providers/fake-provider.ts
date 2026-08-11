import { randomUUID } from "node:crypto";
import type { RepositoryConnection, RepositoryVisibility } from "@paperclipai/shared";
import { conflict, unprocessable } from "../../errors.js";
import type { ProviderRepositorySnapshot } from "../repositories.js";
import { normalizeRepositoryLocator } from "../repository-normalization.js";
import { signConnectionState, verifyConnectionState } from "./connection-state.js";
import type {
  BeginInstallationInput,
  BeginInstallationResult,
  CompleteInstallationInput,
  CompleteInstallationResult,
  DiscoverInput,
  DiscoverResult,
  RefreshMetadataInput,
  RepositoryProviderConnector,
  ResolveCloneCredentialInput,
  ResolveCloneCredentialResult,
} from "./provider-contract.js";

/**
 * In-memory reference provider used by the conformance harness. It implements
 * the full {@link RepositoryProviderConnector} contract with a controllable
 * backing world so tests can exercise installation lifecycle, discovery,
 * pagination, metadata refresh, rename/transfer, revocation, and short-lived
 * clone credential resolution against a known-good implementation.
 */

export interface FakeRepository {
  providerRepositoryId: string;
  owner: string;
  name: string;
  defaultBranch?: string | null;
  visibility?: RepositoryVisibility;
  archived?: boolean;
}

export interface FakeInstallation {
  installationId: string;
  accountId: string;
  accountName: string;
  repositories: FakeRepository[];
}

export interface FakeProviderOptions {
  provider?: string;
  host?: string;
  stateSecret?: string;
  pageSize?: number;
  tokenTtlMs?: number;
  clock?: () => Date;
}

export class FakeRepositoryProvider {
  readonly provider: string;
  readonly host: string;
  private readonly stateSecret: string;
  private readonly defaultPageSize: number;
  private readonly tokenTtlMs: number;
  private readonly clock: () => Date;
  private readonly installations = new Map<string, FakeInstallation>();
  private tokenCounter = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.provider = (options.provider ?? "fake").toLowerCase();
    this.host = (options.host ?? "fake.example.com").toLowerCase();
    this.stateSecret = options.stateSecret ?? "fake-state-secret";
    this.defaultPageSize = options.pageSize ?? 2;
    this.tokenTtlMs = options.tokenTtlMs ?? 60 * 60 * 1000;
    this.clock = options.clock ?? (() => new Date());
  }

  /** Register/replace an installation's repository set. */
  setInstallation(installation: FakeInstallation) {
    this.installations.set(installation.installationId, {
      ...installation,
      repositories: [...installation.repositories],
    });
  }

  /** Rename/transfer a repository, keeping its provider id stable. */
  rename(installationId: string, providerRepositoryId: string, next: { owner: string; name: string }) {
    const installation = this.installations.get(installationId);
    const repo = installation?.repositories.find((r) => r.providerRepositoryId === providerRepositoryId);
    if (!repo) throw new Error(`fake repository ${providerRepositoryId} not found`);
    repo.owner = next.owner;
    repo.name = next.name;
  }

  private cloneUrl(repo: FakeRepository) {
    return `https://${this.host}/${repo.owner}/${repo.name}.git`;
  }

  private webUrl(repo: FakeRepository) {
    return `https://${this.host}/${repo.owner}/${repo.name}`;
  }

  private snapshot(repo: FakeRepository): ProviderRepositorySnapshot {
    return {
      providerRepositoryId: repo.providerRepositoryId,
      cloneUrl: this.cloneUrl(repo),
      webUrl: this.webUrl(repo),
      defaultBranch: repo.defaultBranch ?? "main",
      visibility: repo.visibility ?? "private",
      state: repo.archived ? "unavailable" : "active",
      unavailableReason: repo.archived ? "Repository is archived" : null,
      providerMetadata: { owner: repo.owner, name: repo.name, archived: repo.archived ?? false },
    };
  }

  private requireInstallation(connection: RepositoryConnection): FakeInstallation {
    if (!connection.installationId) throw unprocessable("Connection is missing an installation id");
    const installation = this.installations.get(connection.installationId);
    if (!installation) throw unprocessable("Installation was not found");
    return installation;
  }

  connector(): RepositoryProviderConnector {
    const self = this;
    return {
      provider: self.provider,
      host: self.host,

      async beginInstallation(input: BeginInstallationInput): Promise<BeginInstallationResult> {
        const ttlMs = 10 * 60 * 1000;
        const { state, payload } = signConnectionState({
          companyId: input.companyId,
          userId: input.userId,
          provider: self.provider,
          redirectPath: input.redirectPath ?? null,
          secret: self.stateSecret,
          ttlMs,
          nonce: randomUUID(),
          now: self.clock(),
        });
        return {
          installUrl: `https://${self.host}/install?state=${encodeURIComponent(state)}`,
          state,
          expiresAt: new Date(payload.exp),
        };
      },

      async completeInstallation(input: CompleteInstallationInput): Promise<CompleteInstallationResult> {
        const payload = verifyConnectionState({
          state: input.state,
          provider: self.provider,
          secret: self.stateSecret,
          now: self.clock(),
        });
        if (payload.companyId !== input.companyId) throw conflict("Connection state company mismatch");
        const installation = self.installations.get(input.installationId);
        if (!installation) throw unprocessable("Installation was not found");
        return {
          companyId: payload.companyId,
          userId: payload.userId,
          installationId: installation.installationId,
          accountId: installation.accountId,
          accountName: installation.accountName,
          host: self.host,
          providerMetadata: { account_login: installation.accountName },
        };
      },

      async discover(input: DiscoverInput): Promise<DiscoverResult> {
        const installation = self.requireInstallation(input.connection);
        const perPage = input.pageSize ?? self.defaultPageSize;
        const page = input.cursor ? Number.parseInt(input.cursor, 10) : 1;
        if (!Number.isFinite(page) || page < 1) throw unprocessable("Discovery cursor is invalid");
        const query = input.query?.trim().toLowerCase();
        const matches = installation.repositories.filter((repo) =>
          !query || `${repo.owner}/${repo.name}`.toLowerCase().includes(query),
        );
        const start = (page - 1) * perPage;
        const slice = matches.slice(start, start + perPage);
        return {
          items: slice.map((repo) => ({
            providerRepositoryId: repo.providerRepositoryId,
            owner: repo.owner,
            name: repo.name,
            cloneUrl: self.cloneUrl(repo),
            webUrl: self.webUrl(repo),
            defaultBranch: repo.defaultBranch ?? "main",
            visibility: repo.visibility ?? "private",
            archived: repo.archived ?? false,
            metadata: { owner: repo.owner, name: repo.name },
          })),
          nextCursor: start + perPage < matches.length ? String(page + 1) : null,
          total: matches.length,
        };
      },

      async refreshMetadata(input: RefreshMetadataInput): Promise<ProviderRepositorySnapshot | null> {
        const installation = self.requireInstallation(input.connection);
        const repo = installation.repositories.find((r) => r.providerRepositoryId === input.providerRepositoryId);
        return repo ? self.snapshot(repo) : null;
      },

      async sync(input: { connection: RepositoryConnection; cursor: string | null }) {
        const installation = self.requireInstallation(input.connection);
        return { repositories: installation.repositories.map((repo) => self.snapshot(repo)), cursor: null };
      },

      async resolveCloneCredential(input: ResolveCloneCredentialInput): Promise<ResolveCloneCredentialResult> {
        const installation = self.requireInstallation(input.connection);
        self.tokenCounter += 1;
        const token = `fake-token-${self.tokenCounter}`;
        const expiresAt = new Date(self.clock().getTime() + self.tokenTtlMs);
        return {
          username: "x-access-token",
          token,
          authenticatedCloneUrl:
            `https://x-access-token:${token}@${input.repository.host}/${input.repository.owner}/${input.repository.name}.git`,
          expiresAt,
          audit: {
            provider: self.provider,
            host: self.host,
            connectionId: input.connection.id,
            repositoryId: input.repository.id,
            installationId: installation.installationId,
            expiresAt,
          },
        };
      },

      async disconnect(): Promise<void> {
        // No persisted token to revoke.
      },
    };
  }
}
