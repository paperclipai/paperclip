import { ExternalLink } from "lucide-react";
import { Link } from "@/lib/router";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DiffView } from "./DiffView";
import type { FileEditEvent } from "./FileCard";

interface FileDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  events: FileEditEvent[];
  agentName?: string;
  agentId?: string;
  runId?: string;
}

const EDIT_TYPE_STYLES: Record<string, { label: string; variant: "default" | "secondary" | "destructive" }> = {
  create: { label: "CREATE", variant: "default" },
  modify: { label: "MODIFY", variant: "secondary" },
  delete: { label: "DELETE", variant: "destructive" },
};

function buildGiteaUrl(events: FileEditEvent[]): string | null {
  const withRepo = events.find((e) => e.repoUrl && e.branch);
  if (!withRepo || !withRepo.repoUrl || !withRepo.branch) return null;
  const base = withRepo.repoUrl.replace(/\/$/, "");
  return `${base}/src/branch/${encodeURIComponent(withRepo.branch)}/${withRepo.filePath}`;
}

function formatRelativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export function FileDetailSheet({
  open,
  onOpenChange,
  filePath,
  events,
  agentName,
  agentId,
  runId,
}: FileDetailSheetProps) {
  const latestEvent = events[events.length - 1];
  if (!latestEvent) return null;

  const totalAdded = events.reduce((sum, e) => sum + e.linesAdded, 0);
  const totalRemoved = events.reduce((sum, e) => sum + e.linesRemoved, 0);
  const editStyle = EDIT_TYPE_STYLES[latestEvent.editType] ?? EDIT_TYPE_STYLES.modify;
  const allDiffLines = events.flatMap((e) => e.diff.split("\n"));
  const giteaUrl = buildGiteaUrl(events);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-2xl w-full flex flex-col">
        <SheetHeader className="shrink-0">
          <div className="flex items-center gap-2 pr-8">
            <SheetTitle className="font-mono text-sm truncate" title={filePath}>
              {filePath}
            </SheetTitle>
            <Badge variant={editStyle.variant} className="shrink-0 text-[10px] px-1.5 py-0">
              {editStyle.label}
            </Badge>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="text-green-600 dark:text-green-400">+{totalAdded}</span>
            <span className="text-red-600 dark:text-red-400">-{totalRemoved}</span>
            <span>{events.length} {events.length === 1 ? "edit" : "edits"}</span>
            {agentName && <span>by {agentName}</span>}
            <span>{formatRelativeTime(latestEvent.timestamp)}</span>
          </div>
        </SheetHeader>

        <div className="flex-1 min-h-0 border rounded-md overflow-hidden">
          <DiffView lines={allDiffLines} showLineNumbers className="h-full" />
        </div>

        <div className="shrink-0 flex items-center gap-2 pt-2">
          {giteaUrl && (
            <Button variant="outline" size="sm" asChild>
              <a href={giteaUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                View in Gitea
              </a>
            </Button>
          )}
          {agentId && runId && (
            <Button variant="outline" size="sm" asChild>
              <Link to={`/agents/${agentId}/runs/${runId}`}>
                View Run Transcript
              </Link>
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
