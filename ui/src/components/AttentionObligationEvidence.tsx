import { ArrowUpRight } from "lucide-react";
import type { AttentionItem } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { attentionEvidenceLabel, attentionEvidenceText } from "@/lib/attention-obligations";
import { cn } from "@/lib/utils";

/**
 * The rest of one obligation, folded into its lead card (PAP-749 plan §2,
 * Rule 11): the task that waits on an approval, or the work a failed run
 * blocks. One line each; the lead card keeps the one action.
 */
export function AttentionObligationEvidence({
  item,
  evidence,
  className,
}: {
  item: AttentionItem;
  evidence: readonly AttentionItem[] | undefined;
  className?: string;
}) {
  if (!evidence?.length) return null;
  return (
    <ul
      aria-label="Part of this request"
      data-attention-obligation={item.obligationKey ?? undefined}
      className={cn("space-y-1 border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground", className)}
    >
      {evidence.map((entry) => {
        const { title, detail } = attentionEvidenceText(entry);
        return (
          <li key={entry.id} data-attention-evidence={entry.id} data-attention-evidence-source={entry.sourceKind}>
            <span className="font-medium text-foreground">{attentionEvidenceLabel(item, entry)}: </span>
            {entry.subject.href ? (
              <Link to={entry.subject.href} className="inline-flex items-center gap-1 hover:text-foreground">
                {title}
                <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            ) : (
              <span>{title}</span>
            )}
            {detail ? <span> — {detail}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
