export type DataRecoveryItemType = "company" | "agent" | "project" | "issue";
export type DataRecoveryItemState = "archived" | "terminated" | "hidden";

export interface DataRecoveryItem {
  id: string;
  type: DataRecoveryItemType;
  name: string;
  state: DataRecoveryItemState;
  removedAt: Date | null;
  companyId: string | null;
  companyName: string | null;
  companyStatus: string | null;
  projectId: string | null;
  projectName: string | null;
  href: string | null;
  restoreBlockedReason: string | null;
}

export interface DataRecoveryDetailField {
  label: string;
  value: string | number | boolean | null;
}

export interface DataRecoveryListResponse {
  items: DataRecoveryItem[];
}

export interface DataRecoveryDetailResponse {
  item: DataRecoveryItem;
  details: DataRecoveryDetailField[];
}

export interface DataRecoveryRestoreResponse {
  item: DataRecoveryItem;
}

export interface DataRecoveryRenameResponse {
  item: DataRecoveryItem;
}

export interface DataRecoveryDeleteResponse {
  item: DataRecoveryItem;
}
