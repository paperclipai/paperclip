import type { ExternalObjectMentionSourceKind } from "./constants.js";

export interface ExternalObjectUrlMatch {
  index: number;
  length: number;
  matchedText: string;
}

export interface ExternalObjectCanonicalIdentity {
  scheme: "http" | "https";
  host: string;
  path: string;
  queryParamHashes?: Record<string, string>;
}

export interface ExternalObjectUrlCanonicalizationOptions {
  identityQueryParams?: readonly string[];
}

export interface ExternalObjectCanonicalUrl {
  sanitizedCanonicalUrl: string;
  sanitizedDisplayUrl: string;
  canonicalIdentity: ExternalObjectCanonicalIdentity;
  canonicalIdentityHash: string;
  redactedMatchedText: string;
}

export interface ExternalObjectMentionSource {
  companyId?: string;
  sourceIssueId?: string;
  sourceKind: ExternalObjectMentionSourceKind;
  sourceRecordId?: string | null;
  documentKey?: string | null;
  propertyKey?: string | null;
}

export function formatExternalObjectMentionSourceLabel(source: ExternalObjectMentionSource): string {
  switch (source.sourceKind) {
    case "title":
      return "Title";
    case "description":
      return "Description";
    case "comment":
      return "Comment";
    case "document":
      return source.documentKey ? `Document: ${source.documentKey}` : "Document";
    case "property":
      return source.propertyKey ? `Property: ${source.propertyKey}` : "Property";
    case "plugin":
      return "Plugin";
  }
}
