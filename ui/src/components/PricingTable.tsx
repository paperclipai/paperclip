import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PlanTier } from "@/api/billing";

interface PricingTier {
  tier: PlanTier;
  label: string;
  priceMonthly: number; // cents
  subtitle?: string;
  features: string[];
  projects: string;
  storage: string;
  companies: string;
  support: string;
  messaging: string;
}

const TIERS: PricingTier[] = [
  {
    tier: "trial",
    label: "14-Day Trial",
    priceMonthly: 0,
    subtitle: "No credit card required",
    projects: "1 project",
    storage: "500 MB",
    companies: "1 company",
    support: "Docs only",
    messaging: "Email",
    features: [
      "Unlimited AI agents",
      "1 project",
      "500 MB storage",
      "5 playbook runs/mo",
      "5 KB pages",
      "Email messaging",
    ],
  },
  {
    tier: "starter",
    label: "Starter",
    priceMonthly: 7900,
    projects: "5 projects",
    storage: "5 GB",
    companies: "1 company",
    support: "Email",
    messaging: "Email + Telegram",
    features: [
      "Unlimited AI agents",
      "5 projects",
      "5 GB storage",
      "50 playbook runs/mo",
      "50 KB pages",
      "Email + Telegram",
      "Email support",
    ],
  },
  {
    tier: "growth",
    label: "Growth",
    priceMonthly: 19900,
    projects: "25 projects",
    storage: "15 GB",
    companies: "2 companies",
    support: "Email",
    messaging: "Email + Telegram + Slack + Discord",
    features: [
      "Unlimited AI agents",
      "25 projects",
      "15 GB storage",
      "2 companies",
      "Unlimited playbook runs",
      "Unlimited KB pages",
      "Email + Telegram + Slack + Discord",
      "Email support",
    ],
  },
  {
    tier: "business",
    label: "Business",
    priceMonthly: 59900,
    projects: "Unlimited",
    storage: "50 GB",
    companies: "5 companies",
    support: "Email",
    messaging: "All 4 platforms",
    features: [
      "Unlimited AI agents",
      "Unlimited projects",
      "50 GB storage",
      "5 companies",
      "Unlimited playbook runs",
      "Unlimited KB pages",
      "All messaging integrations",
      "Email support",
    ],
  },
];

function formatPrice(cents: number): string {
  if (cents === 0) return "$0";
  return `$${(cents / 100).toLocaleString()}`;
}

interface PricingTableProps {
  currentTier?: PlanTier;
  onSelectTier?: (tier: PlanTier) => void;
  loading?: boolean;
}

export function PricingTable({ currentTier = "trial", onSelectTier, loading }: PricingTableProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {TIERS.map((tier) => {
        const isCurrent = tier.tier === currentTier;
        const isUpgrade =
          TIERS.findIndex((t) => t.tier === tier.tier) >
          TIERS.findIndex((t) => t.tier === currentTier);
        const isDowngrade =
          TIERS.findIndex((t) => t.tier === tier.tier) <
          TIERS.findIndex((t) => t.tier === currentTier);

        return (
          <div
            key={tier.tier}
            className={`border rounded-lg p-5 flex flex-col ${
              isCurrent
                ? "border-primary bg-primary/5 ring-1 ring-primary"
                : "border-border"
            }`}
          >
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-lg font-semibold">{tier.label}</h3>
                {isCurrent && (
                  <span className="text-xs font-medium bg-primary text-primary-foreground px-2 py-0.5 rounded">
                    Current Plan
                  </span>
                )}
              </div>
              <div className="flex items-baseline gap-1">
                <span className="text-3xl font-bold">{formatPrice(tier.priceMonthly)}</span>
                <span className="text-muted-foreground text-sm">/month</span>
              </div>
              {tier.subtitle && (
                <p className="text-xs text-muted-foreground mt-1">{tier.subtitle}</p>
              )}
            </div>

            <ul className="flex-1 space-y-2 mb-5">
              {tier.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-sm">
                  <Check className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>

            {onSelectTier && (
              <Button
                variant={isCurrent ? "outline" : isUpgrade ? "default" : "outline"}
                disabled={isCurrent || tier.tier === "trial" || loading}
                onClick={() => onSelectTier(tier.tier)}
                className="w-full"
              >
                {isCurrent
                  ? "Current Plan"
                  : isUpgrade
                    ? "Upgrade"
                    : isDowngrade
                      ? "Downgrade"
                      : "Select"}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
