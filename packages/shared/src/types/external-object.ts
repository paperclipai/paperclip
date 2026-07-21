import type {
  ExternalObjectLivenessState,
  ExternalObjectMentionConfidence,
  ExternalObjectMentionSourceKind,
  ExternalObjectStatusCategory,
  ExternalObjectStatusTone,
} from "../constants.js";

export interface ExternalObject {
  id: string;
  companyId: string;
  providerKey: string;
  pluginId: string | null;
  objectType: string;
  externalId: string;
  sanitizedCanonicalUrl: string | null;
  canonicalIdentityHash: string | null;
  displayKey?: string | null;
  iconKey?: string | null;
  displayTitle: string | null;
  statusKey: string | null;
  statusLabel: string | null;
  statusIconKey?: string | null;
  statusCategory: ExternalObjectStatusCategory;
  statusTone: ExternalObjectStatusTone;
  liveness: ExternalObjectLivenessState;
  isTerminal: boolean;
  data: Record<string, unknown>;
  remoteVersion: string | null;
  etag: string | null;
  lastResolvedAt: string | null;
  lastChangedAt: string | null;
  lastErrorAt: string | null;
  nextRefreshAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalObjectMention {
  id: string;
  companyId: string;
  sourceIssueId: string;
  sourceKind: ExternalObjectMentionSourceKind;
  sourceRecordId: string | null;
  documentKey: string | null;
  propertyKey: string | null;
  matchedTextRedacted: string | null;
  sanitizedDisplayUrl: string | null;
  canonicalIdentityHash: string | null;
  canonicalIdentity: Record<string, unknown> | null;
  objectId: string | null;
  providerKey: string | null;
  detectorKey: string | null;
  objectType: string | null;
  confidence: ExternalObjectMentionConfidence;
  createdByPluginId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalObjectMentionGroup {
  object: ExternalObject | null;
  mentions: ExternalObjectMention[];
  mentionCount: number;
  sourceLabels: string[];
}

export interface ExternalObjectSummaryItem {
  id: string;
  providerKey: string;
  objectType: string;
  displayKey?: string | null;
  iconKey?: string | null;
  displayTitle: string | null;
  statusIconKey?: string | null;
  statusCategory: ExternalObjectStatusCategory;
  statusTone: ExternalObjectStatusTone;
  liveness: ExternalObjectLivenessState;
  isTerminal: boolean;
}

export interface ExternalObjectSummary {
  total: number;
  byStatusCategory: Record<string, number>;
  byLiveness: Record<string, number>;
  highestSeverity: ExternalObjectStatusTone;
  staleCount: number;
  authRequiredCount: number;
  unreachableCount: number;
  objects: ExternalObjectSummaryItem[];
}
