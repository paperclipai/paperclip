export type FolderKind = "routine" | "skill";

export interface Folder {
  id: string;
  companyId: string;
  kind: FolderKind;
  parentId: string | null;
  name: string;
  slug: string;
  systemKey: string | null;
  path: string;
  depth: number;
  color: string | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FolderListItem extends Folder {
  itemCount: number;
}

export interface FolderListResult {
  kind: FolderKind;
  folders: FolderListItem[];
  allCount: number;
  unfiledCount: number;
}

export interface CreateFolderRequest {
  kind: FolderKind;
  parentId?: string | null;
  name: string;
  slug?: string | null;
  color?: string | null;
  position?: number | null;
}

export interface UpdateFolderRequest {
  name?: string;
  slug?: string;
  color?: string | null;
  position?: number;
}

export interface MoveFolderRequest {
  parentId?: string | null;
  position: number;
}

export interface EnsureMySkillFolderRequest {
  slug?: string | null;
}

export interface MoveFolderItemRequest {
  kind: FolderKind;
  itemId: string;
  folderId?: string | null;
}
