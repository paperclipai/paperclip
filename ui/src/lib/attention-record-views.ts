import type { QueryClient } from "@tanstack/react-query";
import type { AttentionItem } from "@paperclipai/shared";
import { queryKeys } from "./queryKeys";

/**
 * One record, many views (PAP-749 design review, Part 2). A card's source
 * record also shows in task detail, chat, and the approval, decision and
 * budget pages. After a person acts on a card, each of those reads refetches,
 * not only the Needs You feed. Other people's open pages get the same change
 * from LiveUpdatesProvider.
 */
export function attentionRecordQueryKeys(companyId: string, item: AttentionItem): ReadonlyArray<readonly unknown[]> {
  const keys: Array<readonly unknown[]> = [queryKeys.attention(companyId)];
  const metadata = item.subject.metadata;
  switch (item.sourceKind) {
    case "issue_thread_interaction": {
      // Task detail caches interactions under the route's identifier, while
      // the card resolver uses the task UUID.
      const refs = new Set(
        [metadata?.issueId, item.relatedIssue?.id, item.relatedIssue?.identifier]
          .filter((ref): ref is string => typeof ref === "string" && ref.length > 0),
      );
      for (const ref of refs) keys.push(queryKeys.issues.interactions(ref));
      keys.push(["issues", "pending-questions"], ["issues", "decision-receipts"]);
      break;
    }
    case "approval":
      keys.push(["approvals", companyId], queryKeys.approvals.detail(item.subject.id));
      break;
    case "decision":
      keys.push(["decisions", companyId], queryKeys.decisions.detail(item.subject.id), ["issues", "decision-receipts"]);
      break;
    case "join_request":
      keys.push(queryKeys.access.joinRequests(companyId));
      break;
    case "budget_alert": {
      // A hard stop answers its override approval in the same write (PAP-768).
      keys.push(queryKeys.budgets.overview(companyId), ["approvals", companyId]);
      const approvalId = metadata?.approvalId;
      if (typeof approvalId === "string" && approvalId) keys.push(queryKeys.approvals.detail(approvalId));
      break;
    }
  }
  return keys;
}

export function invalidateAttentionRecordViews(queryClient: QueryClient, companyId: string, item: AttentionItem) {
  for (const queryKey of attentionRecordQueryKeys(companyId, item)) {
    void queryClient.invalidateQueries({ queryKey });
  }
}
