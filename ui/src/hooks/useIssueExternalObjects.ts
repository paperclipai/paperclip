import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ExternalObjectMention,
  ExternalObjectMentionGroup,
  ExternalObjectSummary,
} from "@paperclipai/shared";
import { externalObjectsApi } from "../api/externalObjects";
import { queryKeys } from "../lib/queryKeys";
import { normalizeExternalObjectHref } from "../lib/external-object-href";
import type { MarkdownExternalReferenceMap } from "../components/MarkdownBody";
import type { ExternalObjectPillData } from "../components/ExternalObjectPill";
import { instanceSettingsApi } from "../api/instanceSettings";

export const EXTERNAL_OBJECT_SUMMARY_BATCH_SIZE = 500;

export async function fetchIssueExternalObjectSummariesInBatches(
  companyId: string,
  issueIds: readonly string[],
) {
  const summaries: Record<string, ExternalObjectSummary> = {};
  for (let index = 0; index < issueIds.length; index += EXTERNAL_OBJECT_SUMMARY_BATCH_SIZE) {
    const batch = issueIds.slice(index, index + EXTERNAL_OBJECT_SUMMARY_BATCH_SIZE);
    const response = await externalObjectsApi.getIssueSummaries(companyId, batch);
    Object.assign(summaries, response.summaries);
  }
  return { summaries };
}

/**
 * Browser-side mention-source label. Keep in sync with the shared formatter
 * without coupling this hook to the server-only URL canonicalization helpers.
 */
function formatMentionSourceLabel(mention: ExternalObjectMention): string {
  switch (mention.sourceKind) {
    case "title":
      return "Title";
    case "description":
      return "Description";
    case "comment":
      return "Comment";
    case "document":
      return mention.documentKey ? `Document: ${mention.documentKey}` : "Document";
    case "property":
      return mention.propertyKey ? `Property: ${mention.propertyKey}` : "Property";
    case "plugin":
      return "Plugin";
    default:
      return "Source";
  }
}

export interface IssueExternalObjectGroup {
  pill: ExternalObjectPillData;
  mentionCount: number;
  sourceLabels: string[];
  group: ExternalObjectMentionGroup;
}

export interface IssueExternalObjectsResult {
  isEnabled: boolean;
  groups: IssueExternalObjectGroup[];
  /** Lookup map for `MarkdownBody`'s `externalReferences` prop. */
  markdownReferences: MarkdownExternalReferenceMap;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

function useExternalObjectsFeature() {
  const query = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  return {
    isEnabled: query.data?.enableExternalObjects === true,
    isLoaded: query.data !== undefined || query.isError,
  };
}

/**
 * Loads `external_objects` for an issue and produces both the per-group rows
 * (used by the property panel and related-work section) and the markdown URL
 * lookup map (used by inline decoration). Single source of truth so every
 * surface reads from the same query result.
 */
export function useIssueExternalObjects(issueId: string | null | undefined): IssueExternalObjectsResult {
  const externalObjectsFeature = useExternalObjectsFeature();
  const enabled = externalObjectsFeature.isEnabled && Boolean(issueId);
  const query = useQuery({
    queryKey: queryKeys.externalObjects.byIssue(issueId ?? "__none__"),
    queryFn: () => externalObjectsApi.listForIssue(issueId!),
    enabled,
    staleTime: 60_000,
  });

  const groups = useMemo<IssueExternalObjectGroup[]>(() => {
    const data = query.data ?? [];
    return data
      .filter((entry): entry is ExternalObjectMentionGroup => Boolean(entry.object))
      .map((entry) => {
        const object = entry.object!;
        const sourceLabels = entry.sourceLabels && entry.sourceLabels.length > 0
          ? entry.sourceLabels
          : Array.from(new Set(entry.mentions.map(formatMentionSourceLabel)));
        return {
          group: entry,
          mentionCount: entry.mentionCount ?? entry.mentions.length,
          sourceLabels,
          pill: {
            providerKey: object.providerKey,
            objectType: object.objectType,
            displayKey: object.displayKey,
            iconKey: object.iconKey,
            statusCategory: object.statusCategory,
            liveness: object.liveness,
            displayTitle: object.displayTitle,
            statusLabel: object.statusLabel,
            statusIconKey: object.statusIconKey,
            url: object.sanitizedCanonicalUrl,
          },
        };
      });
  }, [query.data]);

  const markdownReferences = useMemo<MarkdownExternalReferenceMap>(() => {
    const result: MarkdownExternalReferenceMap = {};
    for (const { group } of groups) {
      const object = group.object;
      if (!object) continue;
      // Index by the object's canonical URL.
      const canonical = normalizeExternalObjectHref(object.sanitizedCanonicalUrl ?? null);
      if (canonical) {
        result[canonical] = {
          providerKey: object.providerKey,
          objectType: object.objectType,
          displayKey: object.displayKey,
          iconKey: object.iconKey,
          statusCategory: object.statusCategory,
          liveness: object.liveness,
          statusLabel: object.statusLabel,
          statusIconKey: object.statusIconKey,
          displayTitle: object.displayTitle,
        };
      }
      // Also index by every mention's sanitized display URL so user-pasted
      // hrefs that differ only in case/punctuation still resolve.
      for (const mention of group.mentions) {
        const normalizedMention = normalizeExternalObjectHref(
          mention.sanitizedDisplayUrl ?? null,
        );
        if (normalizedMention && !result[normalizedMention]) {
          result[normalizedMention] = {
            providerKey: object.providerKey,
            objectType: object.objectType,
            displayKey: object.displayKey,
            iconKey: object.iconKey,
            statusCategory: object.statusCategory,
            liveness: object.liveness,
            statusLabel: object.statusLabel,
            statusIconKey: object.statusIconKey,
            displayTitle: object.displayTitle,
          };
        }
      }
    }
    return result;
  }, [groups]);

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query.refetch]);

  return {
    isEnabled: externalObjectsFeature.isEnabled,
    groups,
    markdownReferences,
    isLoading: enabled && query.isLoading,
    isError: query.isError,
    refetch,
  };
}

export function useIssueExternalObjectSummary(issueId: string | null | undefined): {
  summary: ExternalObjectSummary | null;
  isLoading: boolean;
} {
  const externalObjectsFeature = useExternalObjectsFeature();
  const enabled = externalObjectsFeature.isEnabled && Boolean(issueId);
  const query = useQuery({
    queryKey: queryKeys.externalObjects.issueSummary(issueId ?? "__none__"),
    queryFn: () => externalObjectsApi.getIssueSummary(issueId!),
    enabled,
    staleTime: 60_000,
  });
  return {
    summary: query.data ?? null,
    isLoading: enabled && query.isLoading,
  };
}

export function useIssueExternalObjectSummaries(
  companyId: string | null | undefined,
  issueIds: readonly string[],
): {
  summaries: Map<string, ExternalObjectSummary>;
  isLoading: boolean;
  isReady: boolean;
} {
  const externalObjectsFeature = useExternalObjectsFeature();
  const normalizedIssueIds = useMemo(
    () => [...new Set(issueIds.filter((issueId) => issueId.length > 0))].sort(),
    [issueIds],
  );
  const enabled = externalObjectsFeature.isEnabled && Boolean(companyId) && normalizedIssueIds.length > 0;
  const query = useQuery({
    queryKey: queryKeys.externalObjects.issueSummaries(companyId ?? "__none__", normalizedIssueIds),
    queryFn: () => fetchIssueExternalObjectSummariesInBatches(companyId!, normalizedIssueIds),
    enabled,
    staleTime: 60_000,
  });
  const summaries = useMemo(
    () => new Map(Object.entries(query.data?.summaries ?? {})),
    [query.data?.summaries],
  );
  return {
    summaries,
    isLoading: enabled && query.isLoading,
    isReady: externalObjectsFeature.isLoaded && (!enabled || query.isSuccess),
  };
}

export function useProjectExternalObjectSummary(projectId: string | null | undefined): {
  summary: ExternalObjectSummary | null;
  isLoading: boolean;
} {
  const externalObjectsFeature = useExternalObjectsFeature();
  const enabled = externalObjectsFeature.isEnabled && Boolean(projectId);
  const query = useQuery({
    queryKey: queryKeys.externalObjects.projectSummary(projectId ?? "__none__"),
    queryFn: () => externalObjectsApi.getProjectSummary(projectId!),
    enabled,
    staleTime: 60_000,
  });
  return {
    summary: query.data ?? null,
    isLoading: enabled && query.isLoading,
  };
}
