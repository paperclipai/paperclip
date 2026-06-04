import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  BudgetIncident,
  CostByBiller,
  CostByProviderModel,
  CostWindowSpendRow,
  FinanceByBiller,
  FinanceByKind,
  FinanceEvent,
  QuotaWindow,
} from "@paperclipai/shared";
import { AlertTriangle, CheckCircle2, CreditCard, Landmark, ReceiptText, WalletCards } from "lucide-react";
import { AccountingModelCard } from "@/components/AccountingModelCard";
import { BillerSpendCard } from "@/components/BillerSpendCard";
import { BudgetIncidentCard } from "@/components/BudgetIncidentCard";
import { BudgetSidebarMarker, type BudgetSidebarMarkerLevel } from "@/components/BudgetSidebarMarker";
import { ClaudeSubscriptionPanel } from "@/components/ClaudeSubscriptionPanel";
import { CodexSubscriptionPanel } from "@/components/CodexSubscriptionPanel";
import { FinanceBillerCard } from "@/components/FinanceBillerCard";
import { FinanceKindCard } from "@/components/FinanceKindCard";
import { FinanceTimelineCard } from "@/components/FinanceTimelineCard";
import { ProviderQuotaCard } from "@/components/ProviderQuotaCard";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const now = new Date("2026-04-20T12:00:00.000Z");
const windowStart = new Date("2026-04-01T00:00:00.000Z");
const windowEnd = new Date("2026-05-01T00:00:00.000Z");
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="paperclip-story__frame overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="paperclip-story__label">{eyebrow}</div>
        <h2 className="mt-1 text-xl font-semibold">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function CaseFrame({
  title,
  detail,
  tone,
  children,
}: {
  title: string;
  detail: string;
  tone: "healthy" | "warning" | "critical";
  children: ReactNode;
}) {
  const toneClasses = {
    healthy: "border-emerald-500/30 bg-emerald-500/5 text-emerald-500",
    warning: "border-amber-500/30 bg-amber-500/5 text-amber-500",
    critical: "border-red-500/30 bg-red-500/5 text-red-500",
  } satisfies Record<typeof tone, string>;

  return (
    <div className="space-y-3">
      <div className={`rounded-lg border px-3 py-2 ${toneClasses[tone]}`}>
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</div>
      </div>
      {children}
    </div>
  );
}

const budgetIncidents: BudgetIncident[] = [
  {
    id: "incident-agent-resolved",
    companyId: "company-storybook",
    policyId: "budget-agent-codex",
    scopeType: "agent",
    scopeId: "agent-codex",
    scopeName: "CodexCoder",
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    windowStart,
    windowEnd,
    thresholdType: "hard",
    amountLimit: 40_000,
    amountObserved: 42_450,
    status: "resolved",
    approvalId: "approval-budget-resolved",
    approvalStatus: "approved",
    resolvedAt: at(42),
    createdAt: at(180),
    updatedAt: at(42),
  },
  {
    id: "incident-project-pending",
    companyId: "company-storybook",
    policyId: "budget-project-app",
    scopeType: "project",
    scopeId: "project-board-ui",
    scopeName: "Paperclip App",
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    windowStart,
    windowEnd,
    thresholdType: "hard",
    amountLimit: 120_000,
    amountObserved: 131_400,
    status: "open",
    approvalId: "approval-budget-pending",
    approvalStatus: "pending",
    resolvedAt: null,
    createdAt: at(32),
    updatedAt: at(8),
  },
  {
    id: "incident-company-escalated",
    companyId: "company-storybook",
    policyId: "budget-company",
    scopeType: "company",
    scopeId: "company-storybook",
    scopeName: "Paperclip Storybook",
    metric: "billed_cents",
    windowKind: "calendar_month_utc",
    windowStart,
    windowEnd,
    thresholdType: "hard",
    amountLimit: 250_000,
    amountObserved: 287_300,
    status: "open",
    approvalId: "approval-budget-escalated",
    approvalStatus: "revision_requested",
    resolvedAt: null,
    createdAt: at(14),
    updatedAt: at(2),
  },
];

const providerRowsByProvider: Record<string, CostByProviderModel[]> = {
  anthropic: [
    {
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription_included",
      model: "claude-sonnet-4.5",
      costCents: 0,
      inputTokens: 1_420_000,
      cachedInputTokens: 210_000,
      outputTokens: 385_000,
      apiRunCount: 0,
      subscriptionRunCount: 38,
      subscriptionCachedInputTokens: 210_000,
      subscriptionInputTokens: 1_420_000,
      subscriptionOutputTokens: 385_000,
    },
    {
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-opus-4.5",
      costCents: 11_240,
      inputTokens: 280_000,
      cachedInputTokens: 35_000,
      outputTokens: 92_000,
      apiRunCount: 7,
      subscriptionRunCount: 0,
      subscriptionCachedInputTokens: 0,
      subscriptionInputTokens: 0,
      subscriptionOutputTokens: 0,
    },
  ],
  openai: [
    {
      provider: "openai",
      biller: "openai",
      billingType: "subscription_included",
      model: "gpt-5.4-codex",
      costCents: 0,
      inputTokens: 1_050_000,
      cachedInputTokens: 164_000,
      outputTokens: 318_000,
      apiRunCount: 0,
      subscriptionRunCount: 26,
      subscriptionCachedInputTokens: 164_000,
      subscriptionInputTokens: 1_050_000,
      subscriptionOutputTokens: 318_000,
    },
    {
      provider: "openai",
      biller: "openai",
      billingType: "subscription_overage",
      model: "gpt-5.3-codex-spark",
      costCents: 18_900,
      inputTokens: 620_000,
      cachedInputTokens: 91_000,
      outputTokens: 250_000,
      apiRunCount: 9,
      subscriptionRunCount: 12,
      subscriptionCachedInputTokens: 91_000,
      subscriptionInputTokens: 410_000,
      subscriptionOutputTokens: 160_000,
    },
  ],
  openrouter: [
    {
      provider: "anthropic",
      biller: "openrouter",
      billingType: "credits",
      model: "anthropic/claude-sonnet-4.5",
      costCents: 22_640,
      inputTokens: 760_000,
      cachedInputTokens: 120_000,
      outputTokens: 220_000,
      apiRunCount: 19,
      subscriptionRunCount: 0,
      subscriptionCachedInputTokens: 0,
      subscriptionInputTokens: 0,
      subscriptionOutputTokens: 0,
    },
    {
      provider: "google",
      biller: "openrouter",
      billingType: "credits",
      model: "google/gemini-3-pro",
      costCents: 8_920,
      inputTokens: 430_000,
      cachedInputTokens: 44_000,
      outputTokens: 118_000,
      apiRunCount: 11,
      subscriptionRunCount: 0,
      subscriptionCachedInputTokens: 0,
      subscriptionInputTokens: 0,
      subscriptionOutputTokens: 0,
    },
  ],
};

const providerWindowRows: Record<string, CostWindowSpendRow[]> = {
  anthropic: [
    { provider: "anthropic", biller: "anthropic", window: "5h", windowHours: 5, costCents: 1_240, inputTokens: 82_000, cachedInputTokens: 11_000, outputTokens: 19_000 },
    { provider: "anthropic", biller: "anthropic", window: "24h", windowHours: 24, costCents: 3_870, inputTokens: 218_000, cachedInputTokens: 32_000, outputTokens: 64_000 },
    { provider: "anthropic", biller: "anthropic", window: "7d", windowHours: 168, costCents: 11_240, inputTokens: 1_700_000, cachedInputTokens: 245_000, outputTokens: 477_000 },
  ],
  openai: [
    { provider: "openai", biller: "openai", window: "5h", windowHours: 5, costCents: 4_920, inputTokens: 148_000, cachedInputTokens: 18_000, outputTokens: 56_000 },
    { provider: "openai", biller: "openai", window: "24h", windowHours: 24, costCents: 10_430, inputTokens: 398_000, cachedInputTokens: 52_000, outputTokens: 130_000 },
    { provider: "openai", biller: "openai", window: "7d", windowHours: 168, costCents: 18_900, inputTokens: 1_670_000, cachedInputTokens: 255_000, outputTokens: 568_000 },
  ],
  openrouter: [
    { provider: "openrouter", biller: "openrouter", window: "5h", windowHours: 5, costCents: 7_880, inputTokens: 210_000, cachedInputTokens: 20_000, outputTokens: 73_000 },
    { provider: "openrouter", biller: "openrouter", window: "24h", windowHours: 24, costCents: 14_630, inputTokens: 506_000, cachedInputTokens: 51_000, outputTokens: 150_000 },
    { provider: "openrouter", biller: "openrouter", window: "7d", windowHours: 168, costCents: 31_560, inputTokens: 1_190_000, cachedInputTokens: 164_000, outputTokens: 338_000 },
  ],
};

const claudeQuotaWindows: QuotaWindow[] = [
  { label: "Current session", usedPercent: 46, resetsAt: at(-180).toISOString(), valueLabel: null, detail: "Healthy session headroom for review tasks." },
  { label: "Current week all models", usedPercent: 74, resetsAt: at(-5_300).toISOString(), valueLabel: null, detail: "Warning threshold after the release documentation run." },
  { label: "Current week Opus only", usedPercent: 92, resetsAt: at(-5_300).toISOString(), valueLabel: null, detail: "Critical model-specific budget: route default work to Sonnet." },
  { label: "Extra usage", usedPercent: null, resetsAt: null, valueLabel: "$18.40 overage", detail: "Overage billing is enabled for board-approved release checks." },
];

const codexQuotaWindows: QuotaWindow[] = [
  { label: "5h limit", usedPercent: 38, resetsAt: at(-92).toISOString(), valueLabel: null, detail: "Healthy short-window capacity." },
  { label: "Weekly limit", usedPercent: 83, resetsAt: at(-4_720).toISOString(), valueLabel: null, detail: "Warning: schedule high-context follow-ups after reset." },
  { label: "Credits", usedPercent: null, resetsAt: null, valueLabel: "$61.25 remaining", detail: "Credit balance after subscription-covered runs." },
  { label: "GPT-5.3 Codex Spark weekly limit", usedPercent: 96, resetsAt: at(-4_720).toISOString(), valueLabel: null, detail: "Critical model window for Spark-heavy story generation." },
];

const billerSpendRows: Array<{
  state: "healthy" | "warning" | "critical";
  row: CostByBiller;
  providerRows: CostByProviderModel[];
  totalCompanySpendCents: number;
  weekSpendCents: number;
}> = [
  {
    state: "healthy",
    row: {
      biller: "anthropic",
      costCents: 11_240,
      inputTokens: 1_700_000,
      cachedInputTokens: 245_000,
      outputTokens: 477_000,
      apiRunCount: 7,
      subscriptionRunCount: 38,
      subscriptionCachedInputTokens: 210_000,
      subscriptionInputTokens: 1_420_000,
      subscriptionOutputTokens: 385_000,
      providerCount: 1,
      modelCount: 2,
    },
    providerRows: providerRowsByProvider.anthropic,
    totalCompanySpendCents: 83_000,
    weekSpendCents: 3_870,
  },
  {
    state: "warning",
    row: {
      biller: "openai",
      costCents: 18_900,
      inputTokens: 1_670_000,
      cachedInputTokens: 255_000,
      outputTokens: 568_000,
      apiRunCount: 9,
      subscriptionRunCount: 38,
      subscriptionCachedInputTokens: 255_000,
      subscriptionInputTokens: 1_460_000,
      subscriptionOutputTokens: 478_000,
      providerCount: 1,
      modelCount: 2,
    },
    providerRows: providerRowsByProvider.openai,
    totalCompanySpendCents: 218_000,
    weekSpendCents: 10_430,
  },
  {
    state: "critical",
    row: {
      biller: "openrouter",
      costCents: 31_560,
      inputTokens: 1_190_000,
      cachedInputTokens: 164_000,
      outputTokens: 338_000,
      apiRunCount: 30,
      subscriptionRunCount: 0,
      subscriptionCachedInputTokens: 0,
      subscriptionInputTokens: 0,
      subscriptionOutputTokens: 0,
      providerCount: 2,
      modelCount: 2,
    },
    providerRows: providerRowsByProvider.openrouter,
    totalCompanySpendCents: 286_000,
    weekSpendCents: 14_630,
  },
];

const financeBillerRows: FinanceByBiller[] = [
  {
    biller: "openai",
    debitCents: 74_200,
    creditCents: 12_000,
    netCents: 62_200,
    estimatedDebitCents: 18_400,
    eventCount: 7,
    kindCount: 3,
  },
  {
    biller: "aws_bedrock",
    debitCents: 45_880,
    creditCents: 0,
    netCents: 45_880,
    estimatedDebitCents: 45_880,
    eventCount: 4,
    kindCount: 2,
  },
];

const financeKindRows: FinanceByKind[] = [
  {
    eventKind: "inference_charge",
    debitCents: 49_820,
    creditCents: 0,
    netCents: 49_820,
    estimatedDebitCents: 12_700,
    eventCount: 9,
    billerCount: 3,
  },
  {
    eventKind: "log_storage_charge",
    debitCents: 8_760,
    creditCents: 0,
    netCents: 8_760,
    estimatedDebitCents: 8_760,
    eventCount: 3,
    billerCount: 1,
  },
  {
    eventKind: "provisioned_capacity_charge",
    debitCents: 42_900,
    creditCents: 0,
    netCents: 42_900,
    estimatedDebitCents: 42_900,
    eventCount: 2,
    billerCount: 1,
  },
  {
    eventKind: "credit_refund",
    debitCents: 0,
    creditCents: 12_000,
    netCents: -12_000,
    estimatedDebitCents: 0,
    eventCount: 1,
    billerCount: 1,
  },
];

const financeTimelineRows: FinanceEvent[] = [
  {
    id: "finance-event-openai-invoice",
    companyId: "company-storybook",
    agentId: null,
    issueId: null,
    projectId: "project-board-ui",
    goalId: "goal-company",
    heartbeatRunId: null,
    costEventId: null,
    billingCode: "product",
    description: "Monthly ChatGPT/Codex business plan charge for engineering agents.",
    eventKind: "platform_fee",
    direction: "debit",
    biller: "openai",
    provider: "openai",
    executionAdapterType: "codex_local",
    pricingTier: "business",
    region: "us",
    model: null,
    quantity: 8,
    unit: "request",
    amountCents: 40_000,
    currency: "USD",
    estimated: false,
    externalInvoiceId: "INV-2026-04-OPENAI-1184",
    metadataJson: { paymentMethod: "corporate-card" },
    occurredAt: at(1_260),
    createdAt: at(1_255),
  },
  {
    id: "finance-event-bedrock-compute",
    companyId: "company-storybook",
    agentId: "agent-codex",
    issueId: "issue-storybook-1",
    projectId: "project-board-ui",
    goalId: "goal-company",
    heartbeatRunId: "run-storybook",
    costEventId: null,
    billingCode: "product",
    description: "Provisioned Bedrock capacity for release smoke testing.",
    eventKind: "provisioned_capacity_charge",
    direction: "debit",
    biller: "aws_bedrock",
    provider: "anthropic",
    executionAdapterType: "claude_local",
    pricingTier: "provisioned",
    region: "us-east-1",
    model: "claude-sonnet-4.5",
    quantity: 14,
    unit: "model_unit_hour",
    amountCents: 42_900,
    currency: "USD",
    estimated: true,
    externalInvoiceId: "AWS-EST-7713",
    metadataJson: { purchaseOrder: "PO-STORYBOOK-APR" },
    occurredAt: at(420),
    createdAt: at(416),
  },
  {
    id: "finance-event-log-storage",
    companyId: "company-storybook",
    agentId: null,
    issueId: null,
    projectId: "project-observability",
    goalId: "goal-company",
    heartbeatRunId: null,
    costEventId: null,
    billingCode: "ops",
    description: "Log retention and audit bundle storage.",
    eventKind: "log_storage_charge",
    direction: "debit",
    biller: "cloudflare",
    provider: "cloudflare",
    executionAdapterType: null,
    pricingTier: "standard",
    region: "global",
    model: null,
    quantity: 312,
    unit: "gb_month",
    amountCents: 8_760,
    currency: "USD",
    estimated: true,
    externalInvoiceId: "CF-APR-2026-0091",
    metadataJson: null,
    occurredAt: at(210),
    createdAt: at(205),
  },
  {
    id: "finance-event-credit-refund",
    companyId: "company-storybook",
    agentId: null,
    issueId: null,
    projectId: null,
    goalId: "goal-company",
    heartbeatRunId: null,
    costEventId: null,
    billingCode: "finance",
    description: "Credit refund after duplicate OpenAI top-up.",
    eventKind: "credit_refund",
    direction: "credit",
    biller: "openai",
    provider: "openai",
    executionAdapterType: null,
    pricingTier: null,
    region: null,
    model: null,
    quantity: 120,
    unit: "credit_usd",
    amountCents: 12_000,
    currency: "USD",
    estimated: false,
    externalInvoiceId: "CR-2026-04-OPENAI-041",
    metadataJson: null,
    occurredAt: at(64),
    createdAt: at(61),
  },
];

const sidebarMarkers: Array<{
  level: BudgetSidebarMarkerLevel;
  label: string;
  detail: string;
  icon: typeof CheckCircle2;
}> = [
  {
    level: "healthy",
    label: "Healthy",
    detail: "27% of company budget used",
    icon: CheckCircle2,
  },
  {
    level: "warning",
    label: "Warning",
    detail: "86% of project budget used",
    icon: AlertTriangle,
  },
  {
    level: "critical",
    label: "Critical",
    detail: "Agent paused by hard stop",
    icon: WalletCards,
  },
];

function BudgetFinanceMatrix() {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-6">
        <section className="paperclip-story__frame p-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <div className="paperclip-story__label">Budget and finance</div>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight">Spend controls, quotas, and accounting surfaces</h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
                Fixture-backed coverage for the board's cost-control components: active incidents, sidebar budget markers,
                provider quotas, biller allocation, account-level finance events, and subscription quota windows.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">healthy</Badge>
              <Badge variant="outline">warning</Badge>
              <Badge variant="outline">critical</Badge>
            </div>
          </div>
        </section>

        <Section eyebrow="Incidents" title="BudgetIncidentCard resolution, pending, and escalated states">
          <div className="grid gap-5 xl:grid-cols-3">
            <CaseFrame title="Resolved raise-and-resume" detail="Approval approved and incident resolved after the budget was raised." tone="healthy">
              <BudgetIncidentCard
                incident={budgetIncidents[0]!}
                onKeepPaused={() => undefined}
                onRaiseAndResume={() => undefined}
              />
            </CaseFrame>
            <CaseFrame title="Pending board decision" detail="Project execution is paused while a budget approval waits for review." tone="warning">
              <BudgetIncidentCard
                incident={budgetIncidents[1]!}
                onKeepPaused={() => undefined}
                onRaiseAndResume={() => undefined}
              />
            </CaseFrame>
            <CaseFrame title="Escalated hard stop" detail="Company spend exceeded the cap and the first approval needs revision." tone="critical">
              <BudgetIncidentCard
                incident={budgetIncidents[2]!}
                onKeepPaused={() => undefined}
                onRaiseAndResume={() => undefined}
              />
            </CaseFrame>
          </div>
        </Section>

        <Section eyebrow="Sidebar" title="BudgetSidebarMarker healthy, warning, and critical indicators">
          <div className="grid gap-4 md:grid-cols-3">
            {sidebarMarkers.map((marker) => {
              const Icon = marker.icon;
              return (
                <div key={marker.level} className="rounded-lg border border-border bg-background/70 p-4">
                  <div className="flex items-center gap-3">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{marker.label}</div>
                      <div className="text-xs text-muted-foreground">{marker.detail}</div>
                    </div>
                    <BudgetSidebarMarker level={marker.level} title={`${marker.label} budget indicator`} />
                  </div>
                </div>
              );
            })}
          </div>
        </Section>

        <Section eyebrow="Providers" title="ProviderQuotaCard usage bars and subscription quota windows">
          <div className="grid gap-5 xl:grid-cols-3">
            <CaseFrame title="Healthy provider" detail="Anthropic subscription usage still has room in short and weekly windows." tone="healthy">
              <ProviderQuotaCard
                provider="anthropic"
                rows={providerRowsByProvider.anthropic}
                budgetMonthlyCents={250_000}
                totalCompanySpendCents={83_000}
                weekSpendCents={3_870}
                windowRows={providerWindowRows.anthropic}
                showDeficitNotch={false}
                quotaWindows={claudeQuotaWindows}
                quotaSource="anthropic-oauth"
              />
            </CaseFrame>
            <CaseFrame title="Warning provider" detail="Codex weekly usage is high and subscription overage has started." tone="warning">
              <ProviderQuotaCard
                provider="openai"
                rows={providerRowsByProvider.openai}
                budgetMonthlyCents={250_000}
                totalCompanySpendCents={218_000}
                weekSpendCents={10_430}
                windowRows={providerWindowRows.openai}
                showDeficitNotch={false}
                quotaWindows={codexQuotaWindows}
                quotaSource="codex-rpc"
              />
            </CaseFrame>
            <CaseFrame title="Critical biller" detail="OpenRouter credits are beyond the monthly allocation and show deficit treatment." tone="critical">
              <ProviderQuotaCard
                provider="openrouter"
                rows={providerRowsByProvider.openrouter}
                budgetMonthlyCents={250_000}
                totalCompanySpendCents={286_000}
                weekSpendCents={14_630}
                windowRows={providerWindowRows.openrouter}
                showDeficitNotch
                quotaWindows={[
                  { label: "Credits", usedPercent: 97, resetsAt: null, valueLabel: "$8.17 remaining", detail: "Critical credit balance before next top-up." },
                  { label: "Requests", usedPercent: 89, resetsAt: at(-520).toISOString(), valueLabel: null, detail: "Warning-level gateway request window." },
                ]}
                quotaSource="openrouter"
              />
            </CaseFrame>
          </div>
        </Section>

        <Section eyebrow="Accounting" title="AccountingModelCard cost allocation reference">
          <AccountingModelCard />
        </Section>

        <Section eyebrow="Billers" title="BillerSpendCard period comparison and upstream provider split">
          <div className="grid gap-5 xl:grid-cols-3">
            {billerSpendRows.map((entry) => (
              <CaseFrame
                key={entry.row.biller}
                title={`${entry.state[0]!.toUpperCase()}${entry.state.slice(1)} allocation`}
                detail="The card compares period spend, weekly spend, billing types, and upstream providers."
                tone={entry.state}
              >
                <BillerSpendCard
                  row={entry.row}
                  weekSpendCents={entry.weekSpendCents}
                  budgetMonthlyCents={250_000}
                  totalCompanySpendCents={entry.totalCompanySpendCents}
                  providerRows={entry.providerRows}
                />
              </CaseFrame>
            ))}
          </div>
        </Section>

        <Section eyebrow="Finance" title="FinanceBillerCard, FinanceKindCard, and invoice timeline">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]">
            <div className="space-y-5">
              <div className="grid gap-5 md:grid-cols-2">
                {financeBillerRows.map((row) => (
                  <FinanceBillerCard key={row.biller} row={row} />
                ))}
              </div>
              <FinanceTimelineCard rows={financeTimelineRows} />
            </div>
            <div className="space-y-5">
              <FinanceKindCard rows={financeKindRows} />
              <Card className="shadow-none">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ReceiptText className="h-4 w-4" />
                    Category fixtures
                  </CardTitle>
                  <CardDescription>Compute, storage, and API-style finance rows are represented by provisioned capacity, log storage, and inference charges.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm sm:grid-cols-3 xl:grid-cols-1">
                  {[
                    { label: "Compute", value: "$429.00", icon: Landmark },
                    { label: "Storage", value: "$87.60", icon: CreditCard },
                    { label: "API", value: "$498.20", icon: WalletCards },
                  ].map((item) => {
                    const Icon = item.icon;
                    return (
                      <div key={item.label} className="flex items-center justify-between gap-3 border border-border p-3">
                        <span className="inline-flex items-center gap-2 text-muted-foreground">
                          <Icon className="h-4 w-4" />
                          {item.label}
                        </span>
                        <span className="font-mono font-medium">{item.value}</span>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </div>
          </div>
        </Section>

        <Section eyebrow="Subscriptions" title="ClaudeSubscriptionPanel and CodexSubscriptionPanel status windows">
          <div className="grid gap-5 xl:grid-cols-2">
            <ClaudeSubscriptionPanel windows={claudeQuotaWindows} source="anthropic-oauth" />
            <CodexSubscriptionPanel windows={codexQuotaWindows} source="codex-rpc" />
          </div>
          <div className="mt-5 grid gap-5 xl:grid-cols-2">
            <ClaudeSubscriptionPanel
              windows={[]}
              source="claude-cli"
              error="Claude CLI quota polling timed out after 10s. Last successful sample was 18 minutes ago."
            />
            <CodexSubscriptionPanel
              windows={[]}
              source="codex-wham"
              error="Codex app server is unavailable, so live subscription windows cannot be refreshed."
            />
          </div>
        </Section>
      </main>
    </div>
  );
}

const meta = {
  title: "Product/Budget & Finance",
  component: BudgetFinanceMatrix,
  parameters: {
    docs: {
      description: {
        component:
          "Budget and finance stories cover incident resolution states, sidebar markers, provider and biller quotas, finance ledgers, and Claude/Codex subscription panels.",
      },
    },
  },
} satisfies Meta<typeof BudgetFinanceMatrix>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FullMatrix: Story = {};
