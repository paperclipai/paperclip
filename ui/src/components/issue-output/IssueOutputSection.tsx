import { Play } from "lucide-react";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { getIssueOutputs, type IssueOutputItem } from "@/lib/issue-output";
import { OutputPrimaryCard } from "./OutputPrimaryCard";
import { OutputRow } from "./OutputRow";

interface IssueOutputSectionProps {
  workProducts: IssueWorkProduct[] | null | undefined;
  /** Optional resolver for the artifact creator's display name. */
  resolveCreatorName?: (item: IssueOutputItem) => string | null;
}

/**
 * Issue Output surface (PAP-10162 Phase 3).
 *
 * Renders attachment-backed artifact work products as first-class issue
 * outputs: a full-width primary card (video player / image / generic file) with
 * Open + Download, plus compact rows for any additional outputs. The section is
 * omitted entirely when the issue has produced no outputs — we never show a
 * permanent empty card.
 */
export function IssueOutputSection({ workProducts, resolveCreatorName }: IssueOutputSectionProps) {
  const { primary, rest, count } = getIssueOutputs(workProducts);

  if (!primary) return null;

  const creatorFor = (item: IssueOutputItem) => resolveCreatorName?.(item) ?? null;

  return (
    <section className="space-y-3" aria-label="Issue outputs">
      <div className="flex items-center gap-2">
        <Play className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-medium text-muted-foreground">Output</h3>
        <span className="text-xs text-muted-foreground">{count}</span>
      </div>

      {/* Stable anchor target so company Artifacts cards can deep-link to a
          specific work product inside its issue context (PAP-10359). */}
      <div id={`work-product-${primary.id}`} className="scroll-mt-20">
        <OutputPrimaryCard item={primary} creatorName={creatorFor(primary)} />
      </div>

      {rest.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Also produced</p>
          {rest.map((item) => (
            <div key={item.id} id={`work-product-${item.id}`} className="scroll-mt-20">
              <OutputRow item={item} creatorName={creatorFor(item)} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
