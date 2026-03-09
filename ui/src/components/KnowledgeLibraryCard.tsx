import type { KnowledgeItem } from "@paperclipai/shared";
import { Pencil, Trash2 } from "lucide-react";
import { Link } from "../lib/router";
import { KnowledgeKindBadge } from "./KnowledgeKindBadge";

export function KnowledgeLibraryCard({
  item,
  updatedLabel,
  descriptionText,
  onEdit,
  onDelete,
}: {
  item: KnowledgeItem;
  updatedLabel: string;
  descriptionText?: string | null;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const resolvedDescription = descriptionText ?? item.summary ?? null;

  return (
    <div className="border bg-card text-card-foreground shadow-sm">
      <div className="flex items-start justify-between gap-4 px-6 pt-6">
        <div className="min-w-0 space-y-2.5 pt-0.5">
          <div className="flex items-center gap-2 text-sm font-semibold leading-tight break-words [overflow-wrap:anywhere]">
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              {item.title}
            </span>
            <KnowledgeKindBadge kind={item.kind} />
          </div>

          {resolvedDescription ? (
            <p className="text-sm leading-6 text-muted-foreground break-words [overflow-wrap:anywhere]">
              {resolvedDescription}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Link
            to={`/knowledge/${item.id}`}
            className="inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            Open
          </Link>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            onClick={onEdit}
            title="Edit knowledge"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-destructive"
            onClick={onDelete}
            title="Delete knowledge"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="px-6 pb-5 pt-4 text-[11px] text-muted-foreground">
        {updatedLabel}
      </div>
    </div>
  );
}
