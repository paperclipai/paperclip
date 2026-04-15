import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";
import { DiffView } from "./DiffView";
import { cn } from "@/lib/utils";

export interface FileEditEvent {
  filePath: string;
  editType: "create" | "modify" | "delete";
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  timestamp: string;
  seq: number;
  repoUrl?: string;
  branch?: string;
}

interface FileCardProps {
  filePath: string;
  events: FileEditEvent[];
  className?: string;
  onClick?: () => void;
}

const EDIT_TYPE_STYLES: Record<string, { label: string; variant: "default" | "secondary" | "destructive" }> = {
  create: { label: "CREATE", variant: "default" },
  modify: { label: "MODIFY", variant: "secondary" },
  delete: { label: "DELETE", variant: "destructive" },
};

function formatRelativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export function FileCard({ filePath, events, className, onClick }: FileCardProps) {
  const latestEvent = events[events.length - 1];
  if (!latestEvent) return null;

  const totalAdded = events.reduce((sum, e) => sum + e.linesAdded, 0);
  const totalRemoved = events.reduce((sum, e) => sum + e.linesRemoved, 0);
  const editStyle = EDIT_TYPE_STYLES[latestEvent.editType] ?? EDIT_TYPE_STYLES.modify;

  const allDiffLines = events.flatMap((e) => e.diff.split("\n"));

  return (
    <Card
      className={cn("w-80 shrink-0 flex flex-col", onClick && "cursor-pointer hover:border-primary/50 transition-colors", className)}
      onClick={onClick}
    >
      <CardHeader className="p-3 pb-2 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-mono font-medium truncate" title={filePath}>
            {filePath}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            {latestEvent.repoUrl && latestEvent.branch && (
              <a
                href={`${latestEvent.repoUrl.replace(/\/$/, "")}/src/branch/${encodeURIComponent(latestEvent.branch)}/${filePath}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            <Badge variant={editStyle.variant} className="text-[10px] px-1.5 py-0">
              {editStyle.label}
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="text-green-600 dark:text-green-400">+{totalAdded}</span>
          <span className="text-red-600 dark:text-red-400">-{totalRemoved}</span>
          <span>{events.length} {events.length === 1 ? "edit" : "edits"}</span>
          <span>{formatRelativeTime(latestEvent.timestamp)}</span>
        </div>
      </CardHeader>
      <CardContent className="p-0 flex-1 min-h-0">
        <div className="h-48 border-t">
          <DiffView lines={allDiffLines} className="h-full" />
        </div>
      </CardContent>
    </Card>
  );
}
