import { useState } from "react";
import type { Issue } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Popover } from "@heroui/react";
import { StatusIcon } from "./StatusIcon";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { timeAgo } from "../lib/timeAgo";

interface IssuesQuicklookProps {
  issue: Issue;
  children: React.ReactNode;
}

export function IssuesQuicklook({ issue, children }: IssuesQuicklookProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <span
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          {children}
        </span>
      </Popover.Trigger>
      <Popover.Content
        className="w-64 p-3"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <StatusIcon status={issue.status} className="mt-0.5 shrink-0" />
            <Link
              to={createIssueDetailPath(issue.identifier ?? issue.id)}
              className="text-sm font-medium leading-snug hover:underline line-clamp-2"
            >
              {issue.title}
            </Link>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{issue.identifier ?? issue.id.slice(0, 8)}</span>
            <span>·</span>
            <span>{issue.status.replace(/_/g, " ")}</span>
            <span>·</span>
            <span>{timeAgo(new Date(issue.updatedAt))}</span>
          </div>
        </div>
      </Popover.Content>
    </Popover>
  );
}
