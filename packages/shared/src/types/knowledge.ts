import type { KnowledgeEntryStatus, RecordScopeType } from "../constants.js";
import type { AssetFile } from "./asset.js";
import type { RecordLink } from "./record.js";

export interface KnowledgeEntry {
  id: string;
  companyId: string;
  title: string;
  summary: string | null;
  bodyMd: string | null;
  sourceRecordId: string | null;
  kind: string;
  scopeType: RecordScopeType;
  scopeRefId: string;
  status: KnowledgeEntryStatus;
  publishedAt: Date | null;
  metadata: Record<string, unknown> | null;
  attachments?: AssetFile[];
  links?: RecordLink[];
  createdAt: Date;
  updatedAt: Date;
}
