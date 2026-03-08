import type { KnowledgeItem } from "@paperclipai/shared";
import { Trash2 } from "lucide-react";
import { Link } from "../lib/router";

export function IssueKnowledgeCompactRow({
  knowledgeItem,
  detaching,
  onDetach,
}: {
  knowledgeItem: KnowledgeItem;
  detaching: boolean;
  onDetach: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{knowledgeItem.title}</p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Link
          to={`/knowledge/${knowledgeItem.id}`}
          className="inline-flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          Open
        </Link>
        <button
          type="button"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onDetach}
          disabled={detaching}
          title="Detach knowledge"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
