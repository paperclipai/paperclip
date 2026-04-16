import { useRef, useCallback } from "react";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Link } from "@/lib/router";
import { FileCard, type FileEditEvent } from "./FileCard";

interface AgentFileRowProps {
  agentName: string;
  agentId?: string;
  runId?: string;
  issueTitle?: string;
  files: Map<string, FileEditEvent[]>;
  runStatus: string;
  onFileClick?: (filePath: string, events: FileEditEvent[]) => void;
}

export function AgentFileRow({ agentName, agentId, runId, issueTitle, files, runStatus, onFileClick }: AgentFileRowProps) {
  const isActive = runStatus === "running" || runStatus === "queued";
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    // Only hijack vertical scroll when the target is NOT inside a DiffView
    // (DiffView containers have overflow-y-auto and need vertical scroll)
    const target = e.target as HTMLElement;
    if (target.closest("[data-diff-view]")) return;

    const el = scrollRef.current;
    if (!el) return;

    // Translate vertical wheel into horizontal scroll
    if (e.deltaY !== 0) {
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {isActive ? (
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-cyan-500" />
          </span>
        ) : (
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-muted-foreground/35" />
        )}
        {agentId && runId ? (
          <Link
            to={`/agents/${agentId}/runs/${runId}`}
            className="text-sm font-semibold hover:underline"
          >
            {agentName}
          </Link>
        ) : (
          <span className="text-sm font-semibold">{agentName}</span>
        )}
        {issueTitle && (
          <span className="text-xs text-muted-foreground truncate">
            — {issueTitle}
          </span>
        )}
      </div>

      {files.size === 0 ? (
        <p className="text-xs text-muted-foreground pl-5">
          {isActive ? "Running — no file edits yet" : "Finished"}
        </p>
      ) : (
        <ScrollArea className="w-full" onWheel={handleWheel}>
          <div ref={scrollRef} className="flex gap-3 pb-3 pl-5">
            {Array.from(files.entries()).map(([filePath, events]) => (
              <FileCard
                key={filePath}
                filePath={filePath}
                events={events}
                onClick={onFileClick ? () => onFileClick(filePath, events) : undefined}
              />
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      )}
    </div>
  );
}
