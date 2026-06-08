import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyDocumentSummary } from "@paperclipai/shared";
import { documentsApi, type CompanyDocumentListFilters } from "../api/documents";
import { queryKeys } from "../lib/queryKeys";

/**
 * Company documents linked to an issue (its inline issue documents plus any
 * cross-linked company docs). Backs both the inline issue document card feedback
 * counts and the issue "Documents" tab, so they stay in sync from one query.
 */
export function useIssueLinkedDocuments(
  companyId: string | null | undefined,
  issueId: string,
  options: { search?: string; enabled?: boolean } = {},
) {
  const filters: CompanyDocumentListFilters = useMemo(
    () => ({
      targetType: "issue",
      targetId: issueId,
      q: options.search?.trim() || undefined,
      includeArchived: true,
      limit: 200,
    }),
    [issueId, options.search],
  );

  const query = useQuery({
    queryKey: queryKeys.documents.list(companyId ?? "", filters as Record<string, unknown>),
    queryFn: () => documentsApi.list(companyId!, filters),
    enabled: Boolean(companyId) && (options.enabled ?? true),
    placeholderData: (previous) => previous,
  });

  const byId = useMemo(() => {
    const map = new Map<string, CompanyDocumentSummary>();
    for (const doc of query.data ?? []) map.set(doc.id, doc);
    return map;
  }, [query.data]);

  return { ...query, documents: query.data ?? [], byId };
}
