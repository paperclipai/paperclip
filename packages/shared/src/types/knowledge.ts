import type { KnowledgeItemKind } from "../constants.js";
import type { AssetImage } from "./asset.js";

export interface KnowledgeItem {
  id: string;
  companyId: string;
  title: string;
  kind: KnowledgeItemKind;
  summary: string | null;
  body: string | null;
  assetId: string | null;
  sourceUrl: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  asset?: AssetImage | null;
  contentText?: string | null;
}

export interface IssueKnowledgeAttachment {
  id: string;
  companyId: string;
  issueId: string;
  knowledgeItemId: string;
  sortOrder: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  knowledgeItem?: KnowledgeItem | null;
}
