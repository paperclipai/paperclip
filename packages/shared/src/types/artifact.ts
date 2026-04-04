export type ArtifactFolderSourceType = "project" | "issue" | "custom";

export interface ArtifactFolder {
  id: string;
  companyId: string;
  parentId: string | null;
  name: string;
  path: string;
  sourceType: ArtifactFolderSourceType | null;
  sourceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ArtifactFolderTreeNode extends ArtifactFolder {
  children: ArtifactFolderTreeNode[];
  fileCount: number;
}

export interface Artifact {
  id: string;
  companyId: string;
  folderId: string;
  assetId: string;
  title: string;
  description: string | null;
  mimeType: string;
  issueId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ArtifactWithFolder extends Artifact {
  folder: ArtifactFolder;
}
