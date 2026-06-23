import { Database, Gauge, ReceiptText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { t, useTranslation } from "@/i18n";

const getSurfaces = () => [
  {
    id: "inference",
    title: t("components.accountingModelCard.inferenceLedgerTitle", { defaultValue: "Inference ledger" }),
    description: t("components.accountingModelCard.inferenceLedgerDescription", {
      defaultValue: "Request-scoped usage and billed runs from cost_events.",
    }),
    icon: Database,
    points: [
      t("components.accountingModelCard.inferencePointTokens", { defaultValue: "tokens + billed dollars" }),
      t("components.accountingModelCard.inferencePointProvider", { defaultValue: "provider, biller, model" }),
      t("components.accountingModelCard.inferencePointSubscription", {
        defaultValue: "subscription and overage aware",
      }),
    ],
    tone: "from-sky-500/12 via-sky-500/6 to-transparent",
  },
  {
    id: "finance",
    title: t("components.accountingModelCard.financeLedgerTitle", { defaultValue: "Finance ledger" }),
    description: t("components.accountingModelCard.financeLedgerDescription", {
      defaultValue: "Account-level charges that are not one prompt-response pair.",
    }),
    icon: ReceiptText,
    points: [
      t("components.accountingModelCard.financePointTopups", { defaultValue: "top-ups, refunds, fees" }),
      t("components.accountingModelCard.financePointBedrock", {
        defaultValue: "Bedrock provisioned or training charges",
      }),
      t("components.accountingModelCard.financePointCredits", { defaultValue: "credit expiries and adjustments" }),
    ],
    tone: "from-amber-500/14 via-amber-500/6 to-transparent",
  },
  {
    id: "quotas",
    title: t("components.accountingModelCard.liveQuotasTitle", { defaultValue: "Live quotas" }),
    description: t("components.accountingModelCard.liveQuotasDescription", {
      defaultValue: "Provider or biller windows that can stop traffic in real time.",
    }),
    icon: Gauge,
    points: [
      t("components.accountingModelCard.quotasPointWindows", { defaultValue: "provider quota windows" }),
      t("components.accountingModelCard.quotasPointBiller", { defaultValue: "biller credit systems" }),
      t("components.accountingModelCard.quotasPointErrors", { defaultValue: "errors surfaced directly" }),
    ],
    tone: "from-emerald-500/14 via-emerald-500/6 to-transparent",
  },
];

export function AccountingModelCard() {
  const { t } = useTranslation();
  const surfaces = getSurfaces();
  return (
    <Card className="relative overflow-hidden border-border/70">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(244,114,182,0.08),transparent_35%),radial-gradient(circle_at_bottom_right,rgba(56,189,248,0.1),transparent_32%)]" />
      <CardHeader className="relative px-5 pt-5 pb-2">
        <CardTitle className="text-sm font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          {t("components.accountingModelCard.cardTitle", { defaultValue: "Accounting model" })}
        </CardTitle>
        <CardDescription className="max-w-2xl text-sm leading-6">
          {t("components.accountingModelCard.cardDescription", {
            defaultValue:
              "Paperclip now separates request-level inference usage from account-level finance events. That keeps provider reporting honest when the biller is OpenRouter, Cloudflare, Bedrock, or another intermediary.",
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="relative grid gap-3 px-5 pb-5 md:grid-cols-3">
        {surfaces.map((surface) => {
          const Icon = surface.icon;
          return (
            <div
              key={surface.id}
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
