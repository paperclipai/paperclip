import { ExternalLink } from "lucide-react";
import { buildCursorCloudSessionUrl } from "@/lib/cursor-cloud-session";
import { cn } from "@/lib/utils";

interface CursorSessionLinkProps {
  cursorAgentId: string;
  className?: string;
  label?: string;
}

export function CursorSessionLink({
  cursorAgentId,
  className,
  label = "Open in Cursor",
}: CursorSessionLinkProps) {
  const href = buildCursorCloudSessionUrl(cursorAgentId);
  const shortId = cursorAgentId.length <= 16
    ? cursorAgentId
    : `${cursorAgentId.slice(0, 10)}…`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={cursorAgentId}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-accent/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
        className,
      )}
    >
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="font-sans">{label}</span>
      <span>{shortId}</span>
    </a>
  );
}
