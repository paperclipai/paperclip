import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { Paperclip } from "lucide-react";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

interface IssuePropertiesArtifactsTabProps {
  issue: Issue;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Artifacts tab of the redesigned properties pane (flag: enableTaskChatRedesign).
 *
 * A read-only gallery of the task's attachments / work products. Uploads,
 * previews, and deletes stay on the existing attachment surfaces for the
 * baseline; this tab consolidates the "what did this task produce" view.
 */
export function IssuePropertiesArtifactsTab({ issue }: IssuePropertiesArtifactsTabProps) {
  const { data } = useQuery({
    queryKey: queryKeys.issues.attachments(issue.id),
    queryFn: () => issuesApi.listAttachments(issue.id),
  });
  const attachments = data ?? [];

  if (attachments.length === 0) {
    return (
      <div className="px-1 py-6 text-sm text-muted-foreground">
        No artifacts yet. Attachments and work products will appear here.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-1 py-2">
      {attachments.map((a) => (
        <li key={a.id}>
          <a
            href={a.contentPath}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-2.5 py-1.5 text-sm hover:bg-accent/50"
          >
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{a.originalFilename ?? a.objectKey}</span>
            <span className="shrink-0 text-(length:--text-micro) text-muted-foreground">{formatBytes(a.byteSize)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
