import type { FinanceByBiller } from "@paperclipai/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents, providerDisplayName } from "@/lib/utils";
import { useI18n } from "../i18n";

interface FinanceBillerCardProps {
  row: FinanceByBiller;
}

export function FinanceBillerCard({ row }: FinanceBillerCardProps) {
  const { locale } = useI18n();
  const copy = locale === "ko"
    ? { event: "건", kind: "종류", net: "순액", debits: "차감", credits: "크레딧", estimated: "추정" }
    : locale === "ja"
      ? { event: "件", kind: "種類", net: "純額", debits: "デビット", credits: "クレジット", estimated: "見積り" }
      : { event: "event", kind: "kind", net: "net", debits: "debits", credits: "credits", estimated: "estimated" };
  return (
    <Card>
      <CardHeader className="px-4 pt-4 pb-1">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{providerDisplayName(row.biller)}</CardTitle>
            <CardDescription className="mt-1 text-xs">
              {locale === "en"
                ? `${row.eventCount} ${copy.event}${row.eventCount === 1 ? "" : "s"} across ${row.kindCount} ${copy.kind}${row.kindCount === 1 ? "" : "s"}`
                : `${row.eventCount}${copy.event} · ${row.kindCount}${copy.kind}`}
            </CardDescription>
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold tabular-nums">{formatCents(row.netCents)}</div>
            <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{copy.net}</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4 pt-3">
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <div className="border border-border p-3">
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{copy.debits}</div>
            <div className="mt-1 font-medium tabular-nums">{formatCents(row.debitCents)}</div>
          </div>
          <div className="border border-border p-3">
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{copy.credits}</div>
            <div className="mt-1 font-medium tabular-nums">{formatCents(row.creditCents)}</div>
          </div>
          <div className="border border-border p-3">
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{copy.estimated}</div>
            <div className="mt-1 font-medium tabular-nums">{formatCents(row.estimatedDebitCents)}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
