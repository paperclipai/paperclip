import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
}

interface FileCardProps {
  filePath: string;
  events: FileEditEvent[];
  className?: string;
}

const EDIT_TYPE_STYLES: Record<string, { label: string; variant: "default" | "secondary" | "destructive" }> = {
  create: { label: "CREATE", variant: "default" },
  modify: { label: "MODIFY", variant: "secondary" },
  delete: { label: "DELETE", variant: "destructive" },
};

export function FileCard({ filePath, events, className }: FileCardProps) {
  const latestEvent = events[events.length - 1];
  if (!latestEvent) return null;

  const totalAdded = events.reduce((sum, e) => sum + e.linesAdded, 0);
  const totalRemoved = events.reduce((sum, e) => sum + e.linesRemoved, 0);
  const editStyle = EDIT_TYPE_STYLES[latestEvent.editType] ?? EDIT_TYPE_STYLES.modify;

  const allDiffLines = events.flatMap((e) => e.diff.split("\n"));

  return (
    <Card className={cn("w-80 shrink-0 flex flex-col", className)}>
      <CardHeader className="p-3 pb-2 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-mono font-medium truncate" title={filePath}>
            {filePath}
          </span>
          <Badge variant={editStyle.variant} className="shrink-0 text-[10px] px-1.5 py-0">
            {editStyle.label}
          </Badge>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="text-green-600 dark:text-green-400">+{totalAdded}</span>
          <span className="text-red-600 dark:text-red-400">-{totalRemoved}</span>
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
