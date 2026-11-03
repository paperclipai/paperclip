import { useMemo, useState } from "react";
import { History } from "lucide-react";
import type { AttentionPersonalView } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { AttentionQueueRow } from "@/components/AttentionQueueRow";
import { AttentionReceiptList, AttentionUnassignedBanner, AttentionViewSwitch } from "@/components/AttentionViews";
import { AttentionStaleGroup } from "@/components/AttentionCloseMenu";
import { DecisionsToolbar } from "@/components/DecisionsToolbar";
import { buildAttentionFilterOptions, defaultAttentionFilterState } from "@/lib/attention";
import type { SurfaceData } from "../../kit";
import { COMPANY } from "../../fixtures";
import { toAttentionItem, toReceipt, USER_LABELS, VIEWER_ID } from "./adapters";

const noop = () => undefined;

export function LandingBody({ records, receipts, counts }: SurfaceData["landing"]) {
  const [view, setView] = useState<AttentionPersonalView>("mine");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(defaultAttentionFilterState);
  const [groupBy, setGroupBy] = useState<"none" | "date" | "type" | "project" | "severity">("none");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const items = useMemo(() => records.filter((record) => !record.stale).map(toAttentionItem), [records]);
  const staleItems = useMemo(() => records.filter((record) => record.stale).map(toAttentionItem), [records]);
  const receiptItems = useMemo(() => receipts.map(toReceipt), [receipts]);
  const [staleOpen, setStaleOpen] = useState(false);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Decisions</h1>
        <Button type="button" variant="ghost" size="sm">
          <History className="h-4 w-4" />
          Decision history
        </Button>
      </div>
      <AttentionViewSwitch value={view} counts={counts} onChange={setView} everyone />
      <DecisionsToolbar
        query={query}
        onQueryChange={setQuery}
        visibleCount={items.length}
        filterOptions={buildAttentionFilterOptions(items)}
        filters={filters}
        onFiltersChange={setFilters}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        sortOrder={sort}
        onSortOrderChange={setSort}
      />
      <AttentionUnassignedBanner count={counts.unassigned} onOpen={noop} />
      <AttentionReceiptList receipts={receiptItems} userLabelMap={USER_LABELS} onDismiss={noop} onOpen={noop} />
      <div className="space-y-3">
        {items.map((item) => (
          <AttentionQueueRow
            key={item.id}
            item={item}
            companyId={COMPANY.id}
            expanded={expandedId === item.id}
            onToggleExpand={(next) => setExpandedId((current) => (current === next.id ? null : next.id))}
            onDismiss={noop}
            currentUserId={VIEWER_ID}
            userLabelMap={USER_LABELS}
          />
        ))}
      </div>
      <AttentionStaleGroup items={staleItems} open={staleOpen} onToggle={() => setStaleOpen((open) => !open)} onWithdrawAll={noop} currentUserId={VIEWER_ID} userLabelMap={USER_LABELS}>
        {staleItems.map((item) => (
          <AttentionQueueRow
            key={item.id}
            item={item}
            companyId={COMPANY.id}
            expanded={false}
            onToggleExpand={noop}
            onDismiss={noop}
            currentUserId={VIEWER_ID}
            userLabelMap={USER_LABELS}
          />
        ))}
      </AttentionStaleGroup>
      <section className="space-y-2 border-t border-border pt-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground">Recent decisions</h2>
          <span className="text-xs text-muted-foreground">Handled by me or for me ▾</span>
        </div>
        <ul className="space-y-1 text-sm text-muted-foreground">
          <li>Approved the September ad budget · NEE-2 · 2d</li>
          <li>Answered the hangtag paper stock · NEE-50 · 2d</li>
          <li>Withdrew the vendor shortlist · NEE-48 · 3d</li>
        </ul>
      </section>
    </div>
  );
}
