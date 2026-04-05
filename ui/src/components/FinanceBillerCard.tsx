import type { FinanceByBiller } from "@paperclipai/shared";
import { formatCents, providerDisplayName } from "@/lib/utils";

interface FinanceBillerCardProps {
  row: FinanceByBiller;
}

export function FinanceBillerCard({ row }: FinanceBillerCardProps) {
  return (
    <div className="border border-border rounded-lg bg-card">
      <div className="px-4 pt-4 pb-1">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-base font-semibold">{providerDisplayName(row.biller)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {row.eventCount} event{row.eventCount === 1 ? "" : "s"} across {row.kindCount} kind{row.kindCount === 1 ? "" : "s"}
            </p>
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold tabular-nums">{formatCents(row.netCents)}</div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">net</div>
          </div>
        </div>
      </div>
      <div className="space-y-3 px-4 pb-4 pt-3">
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <div className="border border-border p-3">
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">debits</div>
            <div className="mt-1 font-medium tabular-nums">{formatCents(row.debitCents)}</div>
          </div>
          <div className="border border-border p-3">
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">credits</div>
            <div className="mt-1 font-medium tabular-nums">{formatCents(row.creditCents)}</div>
          </div>
          <div className="border border-border p-3">
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">estimated</div>
            <div className="mt-1 font-medium tabular-nums">{formatCents(row.estimatedDebitCents)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
