export interface AgentFolder {
  id: string;
  companyId: string;
  parentId: string | null;
  name: string;
  slug: string;
  sortOrder: number;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentFolderListItem extends AgentFolder {
  /** Number of agents filed directly or indirectly under this folder. */
  agentCount: number;
  /** Number of descendant folders (excluding self). */
  descendantCount: number;
}

export interface AgentFolderListResult {
  folders: AgentFolderListItem[];
  totalCount: number;
}

export interface CreateAgentFolder {
  parentId?: string | null;
  name: string;
  slug?: string | null;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
}

export interface UpdateAgentFolder {
  name?: string;
  slug?: string | null;
  sortOrder?: number;
  metadata?: Record<string, unknown> | null;
}

export interface MoveAgentFolder {
  parentId?: string | null;
  sortOrder?: number;
}

export interface MoveAgentToFolder {
  folderId?: string | null;
}
