import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentIcon } from "./AgentIconPicker";
import { deriveInitials } from "./Identity";

export type DocumentFrameHeaderRevisionActor = {
  kind: "agent" | "user" | "system";
  name: string;
  agentIcon?: string | null;
  imageUrl?: string | null;
};

export type DocumentFrameHeaderRevision = {
  id: string;
  revisionNumber: number;
  createdAt: string | Date;
  actor: DocumentFrameHeaderRevisionActor;
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

function RevisionActorAvatar({ actor }: { actor: DocumentFrameHeaderRevisionActor }) {
  return (
    <Avatar size="xs" shape={actor.kind === "agent" ? "square" : "circle"} className="shrink-0">
      {actor.kind === "agent" ? (
        <AvatarFallback>
          <AgentIcon icon={actor.agentIcon} className="h-3 w-3" />
        </AvatarFallback>
      ) : (
        <>
          {actor.imageUrl ? <AvatarImage src={actor.imageUrl} alt={actor.name} /> : null}
          <AvatarFallback>{deriveInitials(actor.name)}</AvatarFallback>
        </>
      )}
    </Avatar>
  );
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
              <Badge variant="outline" className="border-border font-mono text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                {documentKey}
              </Badge>
            </>
          ) : (
            <Badge variant="outline" className="border-border font-mono text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
              {documentKey}
            </Badge>
          )}
          {sourceTrustSlot}
          {revisionMenu ? (
            <DropdownMenu open={revisionMenu.open} onOpenChange={revisionMenu.onOpenChange}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-auto px-1.5 py-0 text-(length:--text-micro) font-normal text-muted-foreground hover:text-foreground",
                    revisionMenu.historicalPreview && "text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200",
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
                                <Badge variant="outline" className="border-border px-1.5 text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                                  Current
                                </Badge>
                              ) : null}
                            </div>
                            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-(length:--text-micro) text-muted-foreground">
                              <RevisionActorAvatar actor={revision.actor} />
                              <span className="truncate">
                                {relativeTime(revision.createdAt)} • {revision.actor.name}
                              </span>
                            </div>
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
              className="truncate text-(length:--text-micro) text-muted-foreground transition-colors hover:text-foreground hover:underline"
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
