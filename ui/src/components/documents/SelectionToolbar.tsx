import type { DocumentSuggestionKind, DocumentSuggestionInsertPosition } from "@paperclipai/shared";
import { ChevronDown, Link2, MessageSquarePlus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface SuggestionDraftIntent {
  kind: DocumentSuggestionKind;
  insertionPosition?: DocumentSuggestionInsertPosition;
}

const SUGGEST_OPTIONS: { label: string; intent: SuggestionDraftIntent }[] = [
  { label: "Replace selection…", intent: { kind: "substitution" } },
  { label: "Delete selection", intent: { kind: "deletion" } },
  { label: "Insert before…", intent: { kind: "insertion", insertionPosition: "before" } },
  { label: "Insert after…", intent: { kind: "insertion", insertionPosition: "after" } },
];

export interface SelectionToolbarProps {
  /** Add an anchored comment on the current selection. */
  onComment: () => void;
  /** Start a suggested-edit draft of a given kind on the current selection. */
  onSuggest: (intent: SuggestionDraftIntent) => void;
  /** Copy a deep link to the current selection. Omitted hides the button. */
  onCopyLink?: () => void;
  commentDisabled?: boolean;
  commentDisabledReason?: string | null;
  suggestDisabled?: boolean;
  suggestDisabledReason?: string | null;
  className?: string;
}

/**
 * NEW floating selection toolbar shown when the reader selects body text. Offers
 * "Comment" and a "Suggest edit ▾" menu (Replace / Delete / Insert before /
 * Insert after — the four Roughdraft primitives) plus an optional copy-link. The
 * caret-anchored positioning is owned by the body annotation layer; this is the
 * presentational action cluster injected into it (and reused standalone in
 * Storybook/tests).
 */
export function SelectionToolbar({
  onComment,
  onSuggest,
  onCopyLink,
  commentDisabled,
  commentDisabledReason,
  suggestDisabled,
  suggestDisabledReason,
  className,
}: SelectionToolbarProps) {
  return (
    <div
      data-testid="document-selection-toolbar"
      role="toolbar"
      aria-label="Selection actions"
      className={cn("flex items-center gap-0.5", className)}
      onMouseDown={(event) => event.preventDefault()}
    >
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 gap-1 px-2 text-xs"
        onClick={onComment}
        disabled={commentDisabled}
        title={commentDisabled ? commentDisabledReason ?? undefined : "Add comment on selection (⌘⇧M)"}
        data-testid="selection-toolbar-comment"
      >
        <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
        Comment
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            disabled={suggestDisabled}
            title={suggestDisabled ? suggestDisabledReason ?? undefined : "Suggest an edit on selection"}
            data-testid="selection-toolbar-suggest"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            Suggest edit
            <ChevronDown className="h-3 w-3 opacity-70" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44">
          {SUGGEST_OPTIONS.map((option) => (
            <DropdownMenuItem
              key={option.label}
              onSelect={() => onSuggest(option.intent)}
              data-testid={`selection-toolbar-suggest-${option.intent.kind}${
                option.intent.insertionPosition ? `-${option.intent.insertionPosition}` : ""
              }`}
            >
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {onCopyLink ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="h-7 w-7"
          onClick={onCopyLink}
          aria-label="Copy link to selection"
          title="Copy link to selection"
          data-testid="selection-toolbar-copy"
        >
          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}
