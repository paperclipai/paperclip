import { Database, Gauge, ReceiptText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useTranslation } from "@/i18n";

export function AccountingModelCard() {
  const { t } = useTranslation();
  const SURFACES = [
    {
      title: t("costs.AccountingModelCard.inference.title"),
      description: t("costs.AccountingModelCard.inference.description"),
      icon: Database,
      points: [
        t("costs.AccountingModelCard.inference.point1"),
        t("costs.AccountingModelCard.inference.point2"),
        t("costs.AccountingModelCard.inference.point3"),
      ],
      tone: "from-sky-500/12 via-sky-500/6 to-transparent",
    },
    {
      title: t("costs.AccountingModelCard.finance.title"),
      description: t("costs.AccountingModelCard.finance.description"),
      icon: ReceiptText,
      points: [
        t("costs.AccountingModelCard.finance.point1"),
        t("costs.AccountingModelCard.finance.point2"),
        t("costs.AccountingModelCard.finance.point3"),
      ],
      tone: "from-amber-500/14 via-amber-500/6 to-transparent",
    },
    {
      title: t("costs.AccountingModelCard.quotas.title"),
      description: t("costs.AccountingModelCard.quotas.description"),
      icon: Gauge,
      points: [
        t("costs.AccountingModelCard.quotas.point1"),
        t("costs.AccountingModelCard.quotas.point2"),
        t("costs.AccountingModelCard.quotas.point3"),
      ],
      tone: "from-emerald-500/14 via-emerald-500/6 to-transparent",
    },
  ] as const;

  return (
    <Card className="relative overflow-hidden border-border/70">
      <div className="absolute inset-0 bg-(image:--gradient-extract-3)" />
      <CardHeader className="relative px-5 pt-5 pb-2">
        <CardTitle className="text-sm font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">
          {t("costs.AccountingModelCard.title")}
        </CardTitle>
        <CardDescription className="max-w-2xl text-sm leading-6">
          {t("costs.AccountingModelCard.description")}
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
