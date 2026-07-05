export type FolderKind = "routine" | "skill";

export interface Folder {
  id: string;
  companyId: string;
  kind: FolderKind;
  name: string;
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
  name: string;
  color?: string | null;
  position?: number | null;
}

export interface UpdateFolderRequest {
  name?: string;
  color?: string | null;
  position?: number;
}

export interface MoveFolderRequest {
  position: number;
}

export interface MoveFolderItemRequest {
  kind: FolderKind;
  itemId: string;
  folderId?: string | null;
}
