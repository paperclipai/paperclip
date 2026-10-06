import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";

export type MatchSourceChipKind = "title" | "identifier" | "comment" | "document";

const chipStyles: Record<MatchSourceChipKind, string> = {
  title:
    "bg-(--chip-match-title-bg) text-(--chip-match-title-fg) border-(--chip-match-title-border)",
  identifier:
    "bg-(--chip-match-identifier-bg) text-(--chip-match-identifier-fg) border-(--chip-match-identifier-border)",
  comment:
    "bg-(--chip-match-comment-bg) text-(--chip-match-comment-fg) border-(--chip-match-comment-border)",
  document:
    "bg-(--chip-match-document-bg) text-(--chip-match-document-fg) border-(--chip-match-document-border)",
};

const chipLabels: Record<MatchSourceChipKind, string> = {
  title: "localizationFilters.sourcetitle",
  identifier: "localizationFilters.sourceidentifier",
  comment: "localizationFilters.sourcecomment",
  document: "localizationFilters.sourcedocument",
};

export interface MatchSourceChipProps {
  kind: MatchSourceChipKind;
  count?: number;
  label?: string;
  className?: string;
}

// design-allow(pill-pattern): --chip-match-* domain token family (DESIGN.md domain tier); a
// deliberately separate chip system, not a Badge.
export function MatchSourceChip({ kind, count, label, className }: MatchSourceChipProps) {
  const { t } = useTranslation();
  const text = label ?? t(chipLabels[kind]);
  const showCount = typeof count === "number" && count > 1;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-px text-(length:--text-micro) font-medium leading-none whitespace-nowrap",
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
