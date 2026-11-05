import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { createIssueDetailPath, withIssueDetailHeaderSeed } from "../lib/issueDetailBreadcrumb";
import type { ProjectWorkspaceLinkedIssue } from "../lib/project-workspaces-tab";
import { IssueQuicklookCard, QUICKLOOK_CONTENT_CLASS, quicklookAlignOffset } from "./IssueLinkQuicklook";

interface IssuesQuicklookProps {
  issue: ProjectWorkspaceLinkedIssue;
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
        data-quicklook
        className={QUICKLOOK_CONTENT_CLASS}
        side="top"
        align="start"
        alignOffset={quicklookAlignOffset("start")}
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
