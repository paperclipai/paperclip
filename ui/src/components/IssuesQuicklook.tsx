import { useState } from "react";
import type { Issue } from "@paperclipai/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { createIssueDetailPath, withIssueDetailHeaderSeed } from "../lib/issueDetailBreadcrumb";
import { IssueQuicklookCard } from "./IssueLinkQuicklook";

interface IssuesQuicklookProps {
  issue: Issue;
  children: React.ReactNode;
}

export function IssuesQuicklook({ issue, children }: IssuesQuicklookProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        asChild
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3"
        side="top"
        align="start"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <IssueQuicklookCard
          issue={issue}
          linkTo={createIssueDetailPath(issue.identifier ?? issue.id)}
          linkState={withIssueDetailHeaderSeed(null, issue)}
        />
      </PopoverContent>
    </Popover>
  );
}
