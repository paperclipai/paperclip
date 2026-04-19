export type ContextSourceType = "manual" | "upload" | "google_drive" | "plugin";

export type ContextSourceStatus = "ready" | "syncing" | "error" | "disabled";

export type ContextSourceItemStatus = "ready" | "unsupported" | "error";

export interface ProjectContextProfile {
  id: string;
  companyId: string;
  projectId: string;
  goalMarkdown: string;
  instructionsMarkdown: string;
  defaultSkillKeys: string[];
  retrievalEnabled: boolean;
  maxBundleChars: number;
  maxChunks: number;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextSource {
  id: string;
  companyId: string;
  projectId: string;
  sourceType: ContextSourceType;
  provider: string | null;
  title: string;
  uri: string | null;
  status: ContextSourceStatus;
  statusMessage: string | null;
  assetId: string | null;
  externalId: string | null;
  metadata: Record<string, unknown> | null;
  lastSyncedAt: Date | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  itemCount?: number;
  chunkCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextSourceItem {
  id: string;
  companyId: string;
  projectId: string;
  sourceId: string;
  externalId: string | null;
  title: string;
  uri: string | null;
  mimeType: string | null;
  bodyText: string | null;
  bodySha256: string | null;
  status: ContextSourceItemStatus;
  statusMessage: string | null;
  metadata: Record<string, unknown> | null;
  sourceModifiedAt: Date | null;
  indexedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextSourceChunk {
  id: string;
  companyId: string;
  projectId: string;
  sourceId: string;
  itemId: string;
  chunkIndex: number;
  content: string;
  tokenEstimate: number;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface ContextSourceSearchResult {
  chunkId: string;
  sourceId: string;
  itemId: string;
  sourceTitle: string;
  itemTitle: string;
  uri: string | null;
  content: string;
  rank: number;
}

export interface ProjectContextBundleSource {
  sourceId: string;
  itemId: string;
  chunkId: string;
  sourceTitle: string;
  itemTitle: string;
  uri: string | null;
  excerpt: string;
}

export interface ProjectContextBundle {
  projectId: string;
  companyId: string;
  goalMarkdown: string;
  instructionsMarkdown: string;
  defaultSkillKeys: string[];
  sources: ProjectContextBundleSource[];
  warnings: string[];
  generatedAt: string;
  query: string | null;
}

export interface ProjectContextOverview {
  profile: ProjectContextProfile;
  sources: ContextSource[];
}

export interface ProjectContextProfileUpdateRequest {
  goalMarkdown?: string;
  instructionsMarkdown?: string;
  defaultSkillKeys?: string[];
  retrievalEnabled?: boolean;
  maxBundleChars?: number;
  maxChunks?: number;
}

export interface ContextSourceCreateRequest {
  sourceType: ContextSourceType;
  title: string;
  uri?: string | null;
  provider?: string | null;
  externalId?: string | null;
  bodyText?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ContextSourceUpsertItemRequest {
  externalId?: string | null;
  title: string;
  uri?: string | null;
  mimeType?: string | null;
  bodyText?: string | null;
  status?: ContextSourceItemStatus;
  statusMessage?: string | null;
  metadata?: Record<string, unknown> | null;
  sourceModifiedAt?: string | null;
}
