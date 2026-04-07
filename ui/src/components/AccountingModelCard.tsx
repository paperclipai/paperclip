import { Database, Gauge, ReceiptText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const SURFACE_KEYS = [
  {
    titleKey: "costs:accounting.inference_ledger_title",
    defaultTitle: "Inference ledger",
    descKey: "costs:accounting.inference_ledger_desc",
    defaultDesc: "Request-scoped usage and billed runs from cost_events.",
    icon: Database,
    pointKeys: [
      { key: "costs:accounting.inference_point_1", defaultValue: "tokens + billed dollars" },
      { key: "costs:accounting.inference_point_2", defaultValue: "provider, biller, model" },
      { key: "costs:accounting.inference_point_3", defaultValue: "subscription and overage aware" },
    ],
    tone: "from-sky-500/12 via-sky-500/6 to-transparent",
  },
  {
    titleKey: "costs:accounting.finance_ledger_title",
    defaultTitle: "Finance ledger",
    descKey: "costs:accounting.finance_ledger_desc",
    defaultDesc: "Account-level charges that are not one prompt-response pair.",
    icon: ReceiptText,
    pointKeys: [
      { key: "costs:accounting.finance_point_1", defaultValue: "top-ups, refunds, fees" },
      { key: "costs:accounting.finance_point_2", defaultValue: "Bedrock provisioned or training charges" },
      { key: "costs:accounting.finance_point_3", defaultValue: "credit expiries and adjustments" },
    ],
    tone: "from-amber-500/14 via-amber-500/6 to-transparent",
  },
  {
    titleKey: "costs:accounting.live_quotas_title",
    defaultTitle: "Live quotas",
    descKey: "costs:accounting.live_quotas_desc",
    defaultDesc: "Provider or biller windows that can stop traffic in real time.",
    icon: Gauge,
    pointKeys: [
      { key: "costs:accounting.quotas_point_1", defaultValue: "provider quota windows" },
      { key: "costs:accounting.quotas_point_2", defaultValue: "biller credit systems" },
      { key: "costs:accounting.quotas_point_3", defaultValue: "errors surfaced directly" },
    ],
    tone: "from-emerald-500/14 via-emerald-500/6 to-transparent",
  },
] as const;

export function AccountingModelCard() {
  const { t } = useTranslation("costs");
  return (
    <Card className="relative overflow-hidden border-border/70">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(244,114,182,0.08),transparent_35%),radial-gradient(circle_at_bottom_right,rgba(56,189,248,0.1),transparent_32%)]" />
      <CardHeader className="relative px-5 pt-5 pb-2">
        <CardTitle className="text-sm font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          {t("accounting.title", { defaultValue: "Accounting model" })}
        </CardTitle>
        <CardDescription className="max-w-2xl text-sm leading-6">
          {t("accounting.description", { defaultValue: "Paperclip now separates request-level inference usage from account-level finance events. That keeps provider reporting honest when the biller is OpenRouter, Cloudflare, Bedrock, or another intermediary." })}
        </CardDescription>
      </CardHeader>
      <CardContent className="relative grid gap-3 px-5 pb-5 md:grid-cols-3">
        {SURFACE_KEYS.map((surface) => {
          const Icon = surface.icon;
          return (
            <div
              key={surface.titleKey}
              className={`rounded-2xl border border-border/70 bg-gradient-to-br ${surface.tone} p-4 shadow-sm`}
            >
              <div className="mb-3 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border/70 bg-background/80">
                  <Icon className="h-4 w-4 text-foreground" />
                </div>
                <div>
                  <div className="text-sm font-semibold">{t(surface.titleKey, { defaultValue: surface.defaultTitle })}</div>
                  <div className="text-xs text-muted-foreground">{t(surface.descKey, { defaultValue: surface.defaultDesc })}</div>
                </div>
              </div>
              <div className="space-y-1.5 text-xs text-muted-foreground">
                {surface.pointKeys.map((point) => (
                  <div key={point.key}>{t(point.key, { defaultValue: point.defaultValue })}</div>
                ))}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
