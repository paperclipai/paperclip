export interface ProjectQuickLink {
  id: string;
  companyId: string;
  projectId: string;
  title: string;
  url: string;
  siteName: string | null;
  description: string | null;
  imageUrl: string | null;
  faviconUrl: string | null;
  metadataFetchedAt: Date | null;
  position: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectQuickLinkMetadataInput {
  siteName?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  faviconUrl?: string | null;
}

export interface ProjectQuickLinkCreateRequest {
  title?: string;
  url: string;
  position?: number;
  siteName?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  faviconUrl?: string | null;
}

export interface ProjectQuickLinkUpdateRequest {
  title?: string;
  url?: string;
  position?: number;
  siteName?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  faviconUrl?: string | null;
}

export interface ProjectQuickLinkPreviewRequest {
  url: string;
}

export interface ProjectQuickLinkPreview {
  url: string;
  title: string;
  siteName: string | null;
  description: string | null;
  imageUrl: string | null;
  faviconUrl: string | null;
}
