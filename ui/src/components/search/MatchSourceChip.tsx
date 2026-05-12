import { cn } from "@/lib/utils";

export type MatchSourceChipKind = "title" | "identifier" | "comment" | "document";

const chipStyles: Record<MatchSourceChipKind, string> = {
  title:
    "bg-[var(--chip-match-title-bg)] text-[var(--chip-match-title-fg)] border-[var(--chip-match-title-border)]",
  identifier:
    "bg-[var(--chip-match-identifier-bg)] text-[var(--chip-match-identifier-fg)] border-[var(--chip-match-identifier-border)]",
  comment:
    "bg-[var(--chip-match-comment-bg)] text-[var(--chip-match-comment-fg)] border-[var(--chip-match-comment-border)]",
  document:
    "bg-[var(--chip-match-document-bg)] text-[var(--chip-match-document-fg)] border-[var(--chip-match-document-border)]",
};

const chipLabels: Record<MatchSourceChipKind, string> = {
  title: "Title",
  identifier: "Identifier",
  comment: "Comment",
  document: "Doc",
};

export interface MatchSourceChipProps {
  kind: MatchSourceChipKind;
  count?: number;
  label?: string;
  className?: string;
}

export function MatchSourceChip({ kind, count, label, className }: MatchSourceChipProps) {
  const text = label ?? chipLabels[kind];
  const showCount = typeof count === "number" && count > 1;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11px] font-medium leading-none whitespace-nowrap",
        chipStyles[kind],
        className,
      )}
      data-kind={kind}
    >
      {text}
      {showCount ? <span className="opacity-80">×{count}</span> : null}
    </span>
  );
}
