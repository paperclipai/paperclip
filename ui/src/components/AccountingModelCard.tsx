import { t, useTranslation } from "@/i18n";
import { Database, Gauge, ReceiptText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

function accountingSurfaces() {
  return [
  {
    get title() { return t("pages.costs.inferenceLedger"); },
    get description() { return t("localizationAgentChrome.ui79_Request_scoped_usage_and_billed_runs_from_cost_event"); },
    id: "inference",
    icon: Database,
    points: [t("localizationAgentChrome.ui80_tokens_billed_dollars"), t("localizationAgentChrome.ui81_provider_biller_model"), t("localizationAgentChrome.ui82_subscription_and_overage_aware")],
    tone: "from-sky-500/12 via-sky-500/6 to-transparent",
  },
  {
    get title() { return t("pages.costs.financeLedger"); },
    get description() { return t("localizationAgentChrome.ui85_Account_level_charges_that_are_not_one_prompt_respon"); },
    id: "finance",
    icon: ReceiptText,
    points: [t("localizationAgentChrome.ui86_top_ups_refunds_fees"), t("localizationAgentChrome.ui87_Bedrock_provisioned_or_training_charges"), t("localizationAgentChrome.ui88_credit_expiries_and_adjustments")],
    tone: "from-amber-500/14 via-amber-500/6 to-transparent",
  },
  {
    get title() { return t("localizationAgentChrome.ui90_Live_quotas"); },
    get description() { return t("localizationAgentChrome.ui91_Provider_or_biller_windows_that_can_stop_traffic_in_"); },
    id: "quotas",
    icon: Gauge,
    points: [t("localizationAgentChrome.ui92_provider_quota_windows"), t("localizationAgentChrome.ui93_biller_credit_systems"), t("localizationAgentChrome.ui94_errors_surfaced_directly")],
    tone: "from-emerald-500/14 via-emerald-500/6 to-transparent",
  },
] as const;
}

export function AccountingModelCard() {
  const { t } = useTranslation();
  return (
    <Card className="relative overflow-hidden border-border/70">
      <div className="absolute inset-0 bg-(image:--gradient-extract-3)" />
      <CardHeader className="relative px-5 pt-5 pb-2">
        <CardTitle className="text-sm font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">{t("localizationAgentChrome.ui96_Accounting_model")}</CardTitle>
        <CardDescription className="max-w-2xl text-sm leading-6">{t("localizationAgentChrome.ui97_Paperclip_now_separates_request_level_inference_usag")}</CardDescription>
      </CardHeader>
      <CardContent className="relative grid gap-3 px-5 pb-5 md:grid-cols-3">
        {accountingSurfaces().map((surface) => {
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
