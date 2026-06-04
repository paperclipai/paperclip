import { Database, Gauge, ReceiptText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const SURFACES = [
  {
    title: "Inference ledger",
    description: "Request-scoped usage and billed runs from cost_events.",
    icon: Database,
    points: ["tokens + billed dollars", "provider, biller, model", "subscription and overage aware"],
  },
  {
    title: "Finance ledger",
    description: "Account-level charges that are not one prompt-response pair.",
    icon: ReceiptText,
    points: ["top-ups, refunds, fees", "Bedrock provisioned or training charges", "credit expiries and adjustments"],
  },
  {
    title: "Live quotas",
    description: "Provider or biller windows that can stop traffic in real time.",
    icon: Gauge,
    points: ["provider quota windows", "biller credit systems", "errors surfaced directly"],
  },
] as const;

export function AccountingModelCard() {
  return (
    <Card className="relative overflow-hidden border-border">
      <CardHeader className="relative px-5 pt-5 pb-2">
        <CardTitle className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Accounting model
        </CardTitle>
        <CardDescription className="max-w-2xl text-sm leading-6">
          ValAdrien OS now separates request-level inference usage from account-level finance events.
          That keeps provider reporting honest when the biller is OpenRouter, Cloudflare, Bedrock, or another intermediary.
        </CardDescription>
      </CardHeader>
      <CardContent className="relative grid gap-3 px-5 pb-5 md:grid-cols-3">
        {SURFACES.map((surface) => {
          const Icon = surface.icon;
          return (
            <div
              key={surface.title}
              className="rounded-[3px] border border-border bg-secondary/40 p-4"
            >
              <div className="mb-3 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-[3px] border border-border bg-background">
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
