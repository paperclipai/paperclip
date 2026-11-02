import { useEffect, useMemo, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";

/** Enrich visible rows without replacing the index that owns membership and order. */
export function mergeIssueRowDetails(issue: Issue, details: Issue | undefined): Issue {
  if (!details || details.id !== issue.id || details.companyId !== issue.companyId
    || new Date(details.updatedAt).getTime() < new Date(issue.updatedAt).getTime()) return issue;
  return {
    ...issue,
    blockerAttention: details.blockerAttention,
    reviewAttention: details.reviewAttention,
    activeRecoveryAction: details.activeRecoveryAction,
    interruption: details.interruption,
    successfulRunHandoff: details.successfulRunHandoff,
    scheduledRetry: details.scheduledRetry,
  };
}

export function useIssueRowDetails(
  companyId: string | null | undefined,
  root: RefObject<HTMLElement | null>,
  rowIdentity: string,
  enabled: boolean,
  issues: readonly Issue[],
) {
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [saved, setSaved] = useState<{ companyId: string; rows: Map<string, Issue> } | null>(null);
  useEffect(() => {
    const element = root.current;
    if (!enabled || !element) {
      setVisibleIds([]);
      return;
    }
    const selector = "[data-issue-row-details]";
    const observed = new Set<HTMLElement>();
    const visible = new Set<HTMLElement>();
    const publish = () => {
      const next = [...new Set([...visible].map(node => node.dataset.issueRowDetails!))].sort().slice(0, 50);
      setVisibleIds((previous) => previous.join(",") === next.join(",") ? previous : next);
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        if (!observed.has(node)) continue;
        if (entry.isIntersecting) visible.add(node);
        else visible.delete(node);
      }
      publish();
    });
    const syncRows = () => {
      const nodes = new Set(element.querySelectorAll<HTMLElement>(selector));
      for (const node of observed) if (!nodes.has(node)) {
        observer?.unobserve(node);
        observed.delete(node);
        visible.delete(node);
      }
      for (const node of nodes) if (!observed.has(node)) {
        observed.add(node);
        observer?.observe(node);
      }
      if (!observer) {
        visible.clear();
        for (const node of [...nodes].filter(node => !node.closest("[hidden]")).slice(0, 50)) visible.add(node);
      }
      publish();
    };
    syncRows();
    // Board pagination and collapsed lanes can mount rows without changing the
    // collection. Observe only added/removed row markers, not badge/text updates.
    const mutations = new MutationObserver(records => {
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
        node instanceof Element && (node.matches(selector) || node.querySelector(selector)),
      ))) syncRows();
    });
    mutations.observe(element, { childList: true, subtree: true });
    return () => { observer?.disconnect(); mutations.disconnect(); };
  }, [companyId, root, rowIdentity, enabled]);

  const versions = new Map<string, number>();
  for (const issue of issues) {
    versions.set(issue.id, Math.max(versions.get(issue.id) ?? 0, new Date(issue.updatedAt).getTime()));
  }
  const visibleVersions = visibleIds.map((id) => [id, versions.get(id)]);
  const { data, error, refetch } = useQuery({
    queryKey: [...queryKeys.issues.list(companyId ?? "__disabled__"), "visible-row-details", visibleVersions],
    queryFn: ({ signal }) => issuesApi.listCompact(companyId!, {
      ids: visibleIds, projection: "rows", includeRoutineExecutions: true, limit: 50,
    }, { signal }),
    enabled: enabled && !!companyId && visibleIds.length > 0,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (!companyId || !data) return;
    setSaved((previous) => {
      const rows = new Map(previous?.companyId === companyId ? previous.rows : []);
      for (const issue of data) {
        const previousRow = rows.get(issue.id);
        if (!previousRow || new Date(issue.updatedAt).getTime() >= new Date(previousRow.updatedAt).getTime()) {
          rows.set(issue.id, issue as Issue);
        }
      }
      return { companyId, rows };
    });
  }, [companyId, data]);
  const enrichIssueRow = useMemo(() => (issue: Issue) => mergeIssueRowDetails(
    issue, saved && saved.companyId === companyId ? saved.rows.get(issue.id) : undefined,
  ), [companyId, saved]);
  return { enrichIssueRow, error, retry: refetch };
}
