import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { issuesApi } from "@/api/issues";
import type { IssueRowArchiveAction } from "@/components/IssueRow";
import { useOptionalToastActions } from "@/context/ToastContext";
import { useAccountBoundMutation } from "@/hooks/useAccountBoundMutation";
import { bindAccount } from "@/lib/account-scope";
import {
  beginLocalInboxArchive,
  clearLocalInboxArchive,
  confirmLocalInboxArchive,
  invalidateTaskArchiveQueries,
} from "@/lib/inboxArchiveCache";

type ArchiveChange = { companyId: string; issueId: string; reference: string; archive: boolean; owner: string };

function changeKey({ companyId, issueId, owner }: ArchiveChange) {
  return JSON.stringify([companyId, issueId, owner]);
}

export function useTaskArchiveAction(companyId: string | null, userId: string | null) {
  const client = useQueryClient();
  const toast = useOptionalToastActions();
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(inFlight.current);

  const change = useAccountBoundMutation({
    mutationFn: ({ issueId, archive }: ArchiveChange) => archive
      ? issuesApi.archiveFromInbox(issueId)
      : issuesApi.unarchiveFromInbox(issueId),
    onMutate: ({ companyId, issueId, archive }) => archive
      ? { release: beginLocalInboxArchive(companyId, issueId), account: bindAccount(client) }
      : undefined,
    onSuccess: (_result, { companyId, issueId, archive }) => {
      if (archive) confirmLocalInboxArchive(companyId, issueId);
      else clearLocalInboxArchive(companyId, issueId);
    },
    onError: (error, { archive }, context) => {
      context?.release();
      toast?.pushToast({
        title: archive ? "Archive failed" : "Restore failed",
        body: describeError(error).body,
        tone: "error",
      });
    },
    onFinished: (_input, context) => {
      if (context && !context.account.isCurrentScope()) context.release();
    },
    onSettled: (_result, _error, { companyId }) => invalidateTaskArchiveQueries(client, companyId),
  });

  async function submit(input: ArchiveChange) {
    const key = changeKey(input);
    if (inFlight.current.has(key)) return;
    const account = bindAccount(client);
    inFlight.current.add(key);
    setPending(new Set(inFlight.current));
    try {
      await change.mutateAsync(input);
      if (input.archive && account.isCurrentAccount()) {
        toast?.pushToast({
          id: `archive:${input.companyId}:${input.issueId}`,
          dedupe: false,
          title: "Task archived",
          body: input.reference,
          tone: "success",
          ttlMs: 8000,
          action: {
            label: "Undo",
            onClick: () => {
              if (account.isCurrentAccount()) void submit({ ...input, archive: false });
            },
          },
        });
      }
    } catch {
      return;
    } finally {
      inFlight.current.delete(key);
      setPending(new Set(inFlight.current));
    }
  }

  return (issue: Issue): IssueRowArchiveAction | undefined => {
    if (!companyId || !userId || issue.companyId !== companyId || issue.isArchivedForMe === undefined) return;
    const input = { companyId, issueId: issue.id, reference: issue.identifier ?? issue.id, archive: !issue.isArchivedForMe, owner: userId };
    return {
      archived: issue.isArchivedForMe,
      disabled: pending.has(changeKey(input)),
      onClick: () => void submit(input),
    };
  };
}
