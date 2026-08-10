import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { Curtain } from "../DecisionShelf";
import { MarkdownBody, type MarkdownExternalReferenceMap } from "../MarkdownBody";

/**
 * Per-task context digest (flag: enableTaskChatRedesign) — a zero-backend
 * summary that rides in the thread header (so it scrolls with content).
 *
 * Source is the EXISTING per-issue continuation-handoff document; when there is
 * none we fall back to the issue description. Collapsed shows the first
 * sentence; expanded renders the full markdown. No new endpoint — the document
 * query shares its key with the Activity tab and dedupes.
 */
export interface TaskContextDigestProps {
  issueId: string;
  /** Issue description, used when there is no continuation-handoff document. */
  fallbackDescription?: string | null;
  externalReferences?: MarkdownExternalReferenceMap;
}

/** First sentence of the body, for the collapsed one-liner. */
function firstSentence(text: string): string {
  const cleaned = text.trim().replace(/^[#>\-*\s]+/, "").replace(/\s+/g, " ");
  const match = cleaned.match(/^.*?[.!?](\s|$)/);
  const sentence = (match ? match[0] : cleaned).trim();
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}

export function TaskContextDigest({ issueId, fallbackDescription, externalReferences }: TaskContextDigestProps) {
  const [open, setOpen] = useState(false);

  const { data: document } = useQuery({
    queryKey: queryKeys.issues.document(issueId, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY),
    queryFn: async () => {
      try {
        return await issuesApi.getDocument(issueId, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    retry: false,
  });

  const body = document?.body?.trim() || fallbackDescription?.trim() || "";
  if (!body) return null;

  return (
    <div data-testid="task-context-digest">
      <Curtain label={firstSentence(body)} open={open} onToggle={() => setOpen((current) => !current)}>
        <MarkdownBody className="text-sm leading-6" externalReferences={externalReferences}>
          {body}
        </MarkdownBody>
      </Curtain>
    </div>
  );
}
