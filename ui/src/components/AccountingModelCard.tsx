import { Database, Gauge, ReceiptText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useI18n } from "@/i18n";

export function AccountingModelCard() {
  const { t } = useI18n();
  const SURFACES = [
    {
      title: t("costs.accountingModel.inferenceLedgerTitle"),
      description: t("costs.accountingModel.inferenceLedgerDescription"),
      icon: Database,
      points: [t("costs.accountingModel.inferenceLedgerPoint1"), t("costs.accountingModel.inferenceLedgerPoint2"), t("costs.accountingModel.inferenceLedgerPoint3")],
      tone: "from-sky-500/12 via-sky-500/6 to-transparent",
    },
    {
      title: t("costs.accountingModel.financeLedgerTitle"),
      description: t("costs.accountingModel.financeLedgerDescription"),
      icon: ReceiptText,
      points: [t("costs.accountingModel.financeLedgerPoint1"), t("costs.accountingModel.financeLedgerPoint2"), t("costs.accountingModel.financeLedgerPoint3")],
      tone: "from-amber-500/14 via-amber-500/6 to-transparent",
    },
    {
      title: t("costs.accountingModel.liveQuotasTitle"),
      description: t("costs.accountingModel.liveQuotasDescription"),
      icon: Gauge,
      points: [t("costs.accountingModel.liveQuotasPoint1"), t("costs.accountingModel.liveQuotasPoint2"), t("costs.accountingModel.liveQuotasPoint3")],
      tone: "from-emerald-500/14 via-emerald-500/6 to-transparent",
    },
  ] as const;
  return (
    <Card className="relative overflow-hidden border-border/70">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(244,114,182,0.08),transparent_35%),radial-gradient(circle_at_bottom_right,rgba(56,189,248,0.1),transparent_32%)]" />
      <CardHeader className="relative px-5 pt-5 pb-2">
        <CardTitle className="text-sm font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          {t("costs.accountingModel.title")}
        </CardTitle>
        <CardDescription className="max-w-2xl text-sm leading-6">
          {t("costs.accountingModel.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="relative grid gap-3 px-5 pb-5 md:grid-cols-3">
        {SURFACES.map((surface) => {
          const Icon = surface.icon;
          return (
            <div
              key={surface.title}
              className={`rounded-2xl border border-border/70 bg-gradient-to-br ${surface.tone} p-4 shadow-sm`}
            >
              <div className="mb-3 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border/70 bg-background/80">
                  <Icon className="h-4 w-4 text-foreground" />
                </div>
                <div>
                  <div className="text-sm font-semibold">{surface.title}</div>
                  <div className="text-xs text-muted-foreground">{surface.description}</div>
                </div>
              </div>
              <div className="space-y-1.5 text-xs text-muted-foreground">
                {surface.points.map((point) => (
                  <div key={point}>{point}</div>
                ))}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
