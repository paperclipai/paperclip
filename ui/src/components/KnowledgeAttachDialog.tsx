import { useEffect, useMemo, useState } from "react";
import type { KnowledgeItem } from "@paperclipai/shared";
import { BookOpen, Check, ExternalLink, FileText, Link2 } from "lucide-react";
import { filterKnowledgeItems } from "../lib/knowledge-selection";
import { buildKnowledgePreview } from "../lib/knowledge-preview";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Command, CommandInput } from "@/components/ui/command";
import { cn } from "../lib/utils";
import { KnowledgeKindBadge } from "./KnowledgeKindBadge";

interface KnowledgeAttachDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: KnowledgeItem[];
  excludedIds?: ReadonlySet<string>;
  initialSelectedIds?: string[];
  title?: string;
  description?: string;
  confirmLabel?: string;
  submitting?: boolean;
  onConfirm: (knowledgeItemIds: string[]) => void | Promise<void>;
}

const EMPTY_SELECTED_IDS: string[] = [];
const EMPTY_EXCLUDED_IDS = new Set<string>();

function itemSecondaryText(item: KnowledgeItem): string {
  if (item.summary?.trim()) return item.summary.trim();
  if (item.kind === "note" && item.body)
    return buildKnowledgePreview(item.body, 120) ?? "";
  if (item.kind === "url" && item.sourceUrl) return item.sourceUrl;
  if (item.kind === "asset" && item.asset?.originalFilename)
    return item.asset.originalFilename;
  if (item.kind === "asset" && item.assetId) return item.assetId;
  return "";
}

function itemLeadingIcon(item: KnowledgeItem) {
  if (item.kind === "url")
    return <Link2 className="h-4 w-4 text-muted-foreground" />;
  if (item.kind === "asset")
    return <ExternalLink className="h-4 w-4 text-muted-foreground" />;
  return <FileText className="h-4 w-4 text-muted-foreground" />;
}

export function KnowledgeAttachDialog({
  open,
  onOpenChange,
  items,
  excludedIds = EMPTY_EXCLUDED_IDS,
  initialSelectedIds = EMPTY_SELECTED_IDS,
  title = "Attach company knowledge",
  description = "Search reusable notes, links, and assets from the company library.",
  confirmLabel = "Attach selected",
  submitting = false,
  onConfirm,
}: KnowledgeAttachDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const excludedIdsKey = useMemo(
    () => [...excludedIds].sort().join("|"),
    [excludedIds]
  );
  const initialSelectedIdsKey = useMemo(
    () => initialSelectedIds.join("|"),
    [initialSelectedIds]
  );
  const preparedInitialSelectedIds = useMemo(
    () => initialSelectedIds.filter((id) => !excludedIds.has(id)),
    [excludedIdsKey, initialSelectedIdsKey]
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIds(preparedInitialSelectedIds);
  }, [open, preparedInitialSelectedIds]);

  const filteredItems = useMemo(
    () => filterKnowledgeItems(items, query, excludedIds),
    [items, query, excludedIds]
  );

  const selectedCount = selectedIds.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="overflow-hidden p-0 sm:max-w-2xl"
        showCloseButton={!submitting}
      >
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <Command shouldFilter={false} className="rounded-none bg-transparent">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search company knowledge..."
          />
        </Command>

        <div className="max-h-[420px] overflow-y-auto px-2 py-2">
          {filteredItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
              <BookOpen className="h-5 w-5 text-muted-foreground" />
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  No matching knowledge items
                </p>
                <p className="text-xs text-muted-foreground">
                  Try a different search term or create a note in the company
                  library first.
                </p>
              </div>
            </div>
          ) : (
            filteredItems.map((item) => {
              const selected = selectedIds.includes(item.id);
              const secondaryText = itemSecondaryText(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedIds((current) =>
                      current.includes(item.id)
                        ? current.filter((id) => id !== item.id)
                        : [...current, item.id]
                    );
                  }}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-md border border-transparent px-3 py-3 text-left transition-colors hover:bg-accent/40",
                    selected && "border-border bg-accent/30"
                  )}
                >
                  <div className="mt-0.5">{itemLeadingIcon(item)}</div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {item.title}
                      </span>
                      <KnowledgeKindBadge kind={item.kind} />
                    </div>
                    {secondaryText ? (
                      <p className="text-xs leading-5 text-muted-foreground break-words [overflow-wrap:anywhere]">
                        {secondaryText}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background">
                    {selected ? <Check className="h-3 w-3" /> : null}
                  </div>
                </button>
              );
            })
          )}
        </div>

        <DialogFooter className="border-t px-6 py-4 sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {selectedCount === 0
              ? "Select one or more knowledge items."
              : `${selectedCount} selected`}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={() => onConfirm(selectedIds)}
              disabled={selectedCount === 0 || submitting}
            >
              {submitting ? "Working..." : confirmLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
