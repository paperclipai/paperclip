export type RepositoryProvider = "manual" | "github" | (string & {});

export type RepositoryState = "active" | "unavailable" | "archived";

export type RepositoryVisibility = "public" | "private" | "internal" | "unknown";

export interface Repository {
  id: string;
  companyId: string;
  connectionId: string | null;
  provider: RepositoryProvider;
  providerRepositoryId: string | null;
  host: string;
  owner: string;
  name: string;
  cloneUrl: string;
  webUrl: string | null;
  defaultBranch: string | null;
  visibility: RepositoryVisibility;
  state: RepositoryState;
  unavailableReason: string | null;
  providerMetadata: Record<string, unknown> | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RepositoryCatalogItem extends Repository {
  projectCount: number;
  directGrantCount: number;
}

export type RepositoryConnectionStatus = "active" | "error" | "disconnected";
export type RepositoryConnectionSyncStatus = "idle" | "syncing" | "succeeded" | "failed";

export interface RepositoryConnection {
  id: string;
  companyId: string;
  provider: RepositoryProvider;
  host: string;
  installationId: string | null;
  accountId: string | null;
  accountName: string | null;
  status: RepositoryConnectionStatus;
  syncStatus: RepositoryConnectionSyncStatus;
  syncCursor: string | null;
  syncError: string | null;
  lastSyncedAt: Date | null;
  providerMetadata: Record<string, unknown> | null;
  disconnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectRepositoryLink {
  id: string;
  companyId: string;
  projectId: string;
  repositoryId: string;
  displayOrder: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectRepositoryEntry {
  link: ProjectRepositoryLink;
  repository: Repository;
}

export interface AgentRepositoryGrant {
  id: string;
  companyId: string;
  agentId: string;
  repositoryId: string;
  grantedByAgentId: string | null;
  grantedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentRepositoryGrantEntry {
  grant: AgentRepositoryGrant;
  repository: Repository;
}

export interface EffectiveRepositoryProjectSource {
  id: string;
  name: string;
}

export interface EffectiveRepositoryAccess {
  repository: Repository;
  sources: {
    direct: boolean;
    projects: EffectiveRepositoryProjectSource[];
  };
}

/** A provider repository surfaced by discovery, before it is imported. */
export interface RepositoryDiscoveryItem {
  providerRepositoryId: string;
  owner: string;
  name: string;
  cloneUrl: string;
  webUrl: string | null;
  defaultBranch: string | null;
  visibility: RepositoryVisibility;
  archived: boolean;
  /** True when this provider repository is already imported into the catalog. */
  imported: boolean;
  importedRepositoryId: string | null;
  metadata: Record<string, unknown> | null;
}

export interface RepositoryDiscoveryPage {
  connectionId: string;
  items: RepositoryDiscoveryItem[];
  nextCursor: string | null;
  total: number | null;
}

export interface BeginRepositoryConnectionResult {
  provider: RepositoryProvider;
  installUrl: string;
  state: string;
  expiresAt: string;
}

export interface CompleteRepositoryConnectionResult {
  connection: RepositoryConnection;
  created: boolean;
  repositories: Repository[];
}

export interface ImportRepositoriesResult {
  repositories: Repository[];
  imported: number;
  skipped: string[];
}

/** Secret-free repository identity sent to agents and embedded in project payloads. */
export interface RepositoryContext {
  id: string;
  provider: RepositoryProvider;
  host: string;
  owner: string;
  name: string;
  state: RepositoryState;
  unavailableReason: string | null;
  cloneUrl: string | null;
  webUrl: string | null;
  defaultBranch: string | null;
}

export interface ProjectRepositoryHint extends RepositoryContext {
  displayOrder: number;
}

export interface EffectiveRepositoryContext extends RepositoryContext {
  sources: {
    direct: boolean;
    projects: EffectiveRepositoryProjectSource[];
  };
}

export interface RepositoryRelationshipProject {
  id: string;
  name: string;
  displayOrder: number;
}

export interface RepositoryRelationshipAgent {
  id: string;
  name: string;
  title: string | null;
  sources: {
    direct: boolean;
    projects: EffectiveRepositoryProjectSource[];
  };
}

export interface RepositoryRelationships {
  projects: RepositoryRelationshipProject[];
  agents: RepositoryRelationshipAgent[];
}
