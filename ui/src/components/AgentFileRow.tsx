import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { FileCard, type FileEditEvent } from "./FileCard";

interface AgentFileRowProps {
  agentName: string;
  issueTitle?: string;
  issueId?: string | null;
  files: Map<string, FileEditEvent[]>;
  runStatus: string;
}

export function AgentFileRow({ agentName, issueTitle, files, runStatus }: AgentFileRowProps) {
  const isActive = runStatus === "running" || runStatus === "queued";

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
        <span className="text-sm font-semibold">{agentName}</span>
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
        <ScrollArea className="w-full">
          <div className="flex gap-3 pb-3 pl-5">
            {Array.from(files.entries()).map(([filePath, events]) => (
              <FileCard key={filePath} filePath={filePath} events={events} />
            ))}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>
      )}
    </div>
  );
}
