import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type DocumentFrameHeaderRevision = {
  id: string;
  revisionNumber: number;
  createdAt: string | Date;
  actorLabel: string;
};

export type DocumentFrameHeaderRevisionMenu = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
  revisions: DocumentFrameHeaderRevision[];
  selectedRevisionId: string | null;
  currentRevisionId: string | null;
  displayedRevisionNumber: number;
  historicalPreview: boolean;
  onSelectRevision: (revisionId: string, isCurrentRevision: boolean) => void;
};

export interface DocumentFrameHeaderProps {
  documentKey: string;
  documentLabel?: string;
  folded: boolean;
  onToggleFolded: () => void;
  revisionMenu?: DocumentFrameHeaderRevisionMenu;
  updatedAt?: string | Date | null;
  updatedHref?: string;
  sourceTrustSlot?: ReactNode;
  annotationSlot?: ReactNode;
  titleSlot?: ReactNode;
  actionsSlot?: ReactNode;
}

export function DocumentFrameHeader({
  documentKey,
  documentLabel,
  folded,
  onToggleFolded,
  revisionMenu,
  updatedAt,
  updatedHref,
  sourceTrustSlot,
  annotationSlot,
  titleSlot,
  actionsSlot,
}: DocumentFrameHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            onClick={onToggleFolded}
            aria-label={folded ? `Expand ${documentKey} document` : `Collapse ${documentKey} document`}
            aria-expanded={!folded}
          >
            {folded ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          {documentLabel ? (
            <>
              <span className="truncate text-sm font-semibold text-foreground">{documentLabel}</span>
              <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                {documentKey}
              </span>
            </>
          ) : (
            <span className="shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              {documentKey}
            </span>
          )}
          {sourceTrustSlot}
          {revisionMenu ? (
            <DropdownMenu open={revisionMenu.open} onOpenChange={revisionMenu.onOpenChange}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-auto px-1.5 py-0 text-[11px] font-normal text-muted-foreground hover:text-foreground",
                    revisionMenu.historicalPreview && "text-amber-300 hover:text-amber-200",
                  )}
                >
                  rev {revisionMenu.displayedRevisionNumber}
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuLabel>Revision history</DropdownMenuLabel>
                {revisionMenu.loading && revisionMenu.revisions.length === 0 ? (
                  <DropdownMenuItem disabled>Loading revisions...</DropdownMenuItem>
                ) : revisionMenu.revisions.length > 0 ? (
                  <DropdownMenuRadioGroup value={revisionMenu.selectedRevisionId ?? revisionMenu.currentRevisionId ?? ""}>
                    {revisionMenu.revisions.map((revision) => {
                      const isCurrentRevision = revision.id === revisionMenu.currentRevisionId;
                      return (
                        <DropdownMenuRadioItem
                          key={revision.id}
                          value={revision.id}
                          onSelect={() => revisionMenu.onSelectRevision(revision.id, isCurrentRevision)}
                          className="items-start"
                        >
                          <div className="flex min-w-0 flex-col">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">rev {revision.revisionNumber}</span>
                              {isCurrentRevision ? (
                                <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                                  Current
                                </span>
                              ) : null}
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {relativeTime(revision.createdAt)} • {revision.actorLabel}
                            </span>
                          </div>
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                ) : (
                  <DropdownMenuItem disabled>No revisions yet</DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {updatedAt ? (
            <a
              href={updatedHref ?? `#document-${encodeURIComponent(documentKey)}`}
              className="truncate text-[11px] text-muted-foreground transition-colors hover:text-foreground hover:underline"
            >
              updated {relativeTime(updatedAt)}
            </a>
          ) : null}
          {annotationSlot}
        </div>
        {titleSlot}
      </div>
      {actionsSlot ? <div className="flex items-center gap-1 shrink-0">{actionsSlot}</div> : null}
    </div>
  );
}
