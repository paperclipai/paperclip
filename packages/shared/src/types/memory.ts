export interface MemoryEntrySource {
  kind: string;
  id: string;
}

export interface MemoryEntry {
  id: string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  key: string;
  title: string | null;
  body: string;
  tags: string[];
  source: MemoryEntrySource | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface MemoryIngestInput {
  companyId: string;
  projectId?: string | null;
  goalId?: string | null;
  key: string;
  title?: string | null;
  body: string;
  tags?: string[];
  source?: MemoryEntrySource | null;
}

export interface MemorySearchInput {
  companyId: string;
  query?: string;
  projectId?: string | null;
  goalId?: string | null;
  key?: string;
  tags?: string[];
  limit?: number;
}

export interface MemoryBrowseFilters {
  companyId: string;
  projectId?: string | null;
  goalId?: string | null;
  key?: string;
  tags?: string[];
  limit?: number;
}

export interface MemoryUsage {
  count: number;
  lastIngestedAt: Date | string | null;
  [key: string]: unknown;
}

export interface MemoryProvider {
  ingest(input: MemoryIngestInput): Promise<MemoryEntry>;
  search(input: MemorySearchInput): Promise<MemoryEntry[]>;
  get(companyId: string, idOrKey: string): Promise<MemoryEntry | null>;
  browse(filters: MemoryBrowseFilters): Promise<MemoryEntry[]>;
  forget(companyId: string, id: string): Promise<void>;
  usage(companyId: string): Promise<MemoryUsage>;
}
