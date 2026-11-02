import { i18n, t, useTranslation } from "@/i18n";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { SUBSCRIPTION_CURRENCIES, centsToUsd, usdToCents, type SubscriptionAccountReport, type SubscriptionCostReport, type SubscriptionUsage } from "@paperclipai/shared";
import { subscriptionsApi } from "../api/subscriptions";
import { formatCents, formatDateTime, formatTokens, providerDisplayName } from "../lib/utils";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Card } from "./ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function subscriptionMoney(cents: string, currency: string) {
  return currency === "USD" ? formatCents(Number(cents))
    : new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language, { style: "currency", currency, currencyDisplay: "code" }).format(Number(cents) / 100);
}

export function SubscriptionTokenUsage({ usage }: { usage: SubscriptionUsage }) {
  useTranslation();
  return <span className="font-mono text-xs text-muted-foreground">
    {t("oct19Core.subscriptionTokens", { input: formatTokens(usage.inputTokens + usage.cachedInputTokens), output: formatTokens(usage.outputTokens) })}
    {usage.cachedInputTokens > 0 && <span className="block">{t("oct19Core.subscriptionCachedTokens", { tokens: formatTokens(usage.cachedInputTokens) })}</span>}
  </span>;
}

function SubscriptionEditor({ account, accounts, companyId, onDone }: {
  account: SubscriptionAccountReport; accounts: SubscriptionAccountReport[]; companyId: string; onDone: () => void;
}) {
  useTranslation();
  const [plan, setPlan] = useState(account.price.plan);
  const [amount, setAmount] = useState(account.price.amountCents == null ? "" : centsToUsd(account.price.amountCents).replace(/\.?0+$/, ""));
  const [currency, setCurrency] = useState(account.price.currency);
  const [cadence, setCadence] = useState(account.price.cadence);
  const [status, setStatus] = useState(account.price.status);
  const [targetId, setTargetId] = useState("");
  const save = useMutation({ mutationFn: () => subscriptionsApi.update(companyId, account.id, {
    expectedRevision: account.price.revision, plan, amountCents: amount.trim() ? usdToCents(amount.trim()) : null,
    currency: currency as typeof SUBSCRIPTION_CURRENCIES[number], cadence, status,
  }), onSuccess: onDone });
  const link = useMutation({ mutationFn: () => subscriptionsApi.link(companyId, account.id, targetId, account.price.revision,
    accounts.find(row => row.id === targetId)!.price.revision), onSuccess: onDone });
  const targets = accounts.filter(row => row.id !== account.id && row.provider === account.provider && row.canEdit);
  const busy = save.isPending || link.isPending;
  const selectClass = "h-9 rounded-md border border-input bg-background px-3 text-sm";
  return <div className="space-y-5">
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <div className="space-y-2"><Label htmlFor="subscription-plan">{t("oct19Core.subscriptionPlan")}</Label><Input id="subscription-plan" value={plan} onChange={event => setPlan(event.target.value)} required maxLength={100} /></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="subscription-price">{t("oct19Core.coverage092")}</Label><Input id="subscription-price" type="number" min="0" step="any" value={amount} placeholder={t("oct19Core.newSurface046")} onChange={event => setAmount(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="subscription-currency">{t("oct19Core.coverage093")}</Label><select id="subscription-currency" className={selectClass} value={currency} onChange={event => setCurrency(event.target.value)}>{SUBSCRIPTION_CURRENCIES.map(code => <option key={code}>{code}</option>)}</select></div>
        <div className="space-y-2"><Label htmlFor="subscription-cadence">{t("oct19Core.coverage094")}</Label><select id="subscription-cadence" className={selectClass} value={cadence} onChange={event => setCadence(event.target.value as typeof cadence)}><option value="month">{t("oct19Core.coverage095")}</option><option value="year">{t("oct19Core.coverage096")}</option></select></div>
        <div className="space-y-2"><Label htmlFor="subscription-status">{t("oct19Core.coverage097")}</Label><select id="subscription-status" className={selectClass} value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="active">{t("oct19Core.coverage098")}</option><option value="ended">{t("oct19Core.coverage099")}</option><option value="excluded">{t("oct19Core.coverage100")}</option></select></div>
      </div>
      <p className="text-xs text-muted-foreground">{t("oct19Core.coverage101")}</p>
      {save.error && <p role="alert" className="text-sm text-destructive">{t("oct19Core.coverage102")}</p>}
      <div className="flex items-center justify-between"><Button type="button" variant="ghost" disabled={busy} onClick={onDone}>{t("oct19Core.cancel")}</Button><Button type="submit" disabled={busy}>{save.isPending ? t("oct19Core.coverage103") : t("oct19Core.coverage104")}</Button></div>
    </form>
    {targets.length > 0 && <div className="space-y-2 border-t border-border pt-4">
      <Label htmlFor="subscription-link">{t("oct19Core.coverage105")}</Label>
      <select id="subscription-link" className={selectClass} value={targetId} onChange={event => setTargetId(event.target.value)}><option value="">{t("oct19Core.coverage106")}</option>{targets.map(row => <option key={row.id} value={row.id}>{row.name} · {row.price.plan}</option>)}</select>
      <p className="text-xs text-muted-foreground">{t("oct19Core.coverage107")}</p>
      {link.error && <p role="alert" className="text-sm text-destructive">{t("oct19Core.coverage108")}</p>}
      <Button type="button" variant="outline" disabled={!targetId || busy} onClick={() => link.mutate()}>{t("oct19Core.coverage109")}</Button>
    </div>}
  </div>;
}

export function SubscriptionCostCard({ companyId, report, error, onChanged }: {
  companyId: string; report?: SubscriptionCostReport; error?: unknown; onChanged: () => void;
}) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SubscriptionAccountReport | null>(null);
  const closeEditor = () => { setEditing(null); onChanged(); };
  const known = report?.monthlyTotals.length;
  const estimatedCount = report?.monthlyTotals.reduce((sum, total) => sum + total.estimatedCount, 0) ?? 0;
  return <>
    <Card className="block p-4">
      <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("oct19Core.coverage110")}</div>
      <div className="mt-2 font-mono text-2xl font-semibold tabular-nums">
        {known ? report!.monthlyTotals.map(total => <div key={total.currency}>{subscriptionMoney(total.amountCents, total.currency)}<span className="text-sm font-normal">{t("oct19Core.subscriptionMonthSuffix")}</span></div>) : report && report.activeCount === 0 && report.accounts.length > 0 ? t("oct19Core.subscriptionMonthlyPrice", { amount: formatCents(0) }) : "—"}
      </div>
      <div className="mt-1 space-y-1 text-xs text-muted-foreground">
        {report ? <>
          {estimatedCount > 0 && <div><Badge variant="outline" className="font-normal text-muted-foreground">{estimatedCount < report.activeCount - report.unknownPriceCount ? t("oct19Core.coverage111") : t("oct19Core.coverage112")}</Badge></div>}
          {report.unknownPriceCount > 0 && !!known && <div>{t("oct19Core.coverage113")}</div>}
          <div>{report.accounts.length === 0 ? t("oct19Core.coverage114") : <>{t("oct19Core.activeSubscriptions", { count: report.activeCount })}{report.unknownPriceCount > 0 && <> · {t("oct19Core.unknownSubscriptionPrices", { count: report.unknownPriceCount })}</>}</>}</div>
          {report.accounts.length > 0 && <div>{t("oct19Core.coverage115")}</div>}
          {report.unidentifiedAccountCount > 0 && <div>{t("oct19Core.unconfirmedAccountIdentities", { count: report.unidentifiedAccountCount })}</div>}
          <SubscriptionTokenUsage usage={report.subscription} />
        </> : error ? <div>{t("oct19Core.coverage116")}</div> : <div>{t("oct19Core.coverage117")}</div>}
        {report && error ? <div>{t("oct19Core.coverage118")}</div> : null}
      </div>
      <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setOpen(true)} disabled={!report}>{t("oct19Core.coverage119")}</Button>
    </Card>
    <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) setEditing(null); }}>
      <DialogContent className="max-h-(--sz-80vh) overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>{editing ? t("oct19Core.coverage120") : t("oct19Core.coverage110")}</DialogTitle><DialogDescription>{t("oct19Core.coverage121")}</DialogDescription></DialogHeader>
        {editing ? <SubscriptionEditor key={editing.id} companyId={companyId} account={editing} accounts={report?.accounts ?? []} onDone={closeEditor} /> : <div className="space-y-4">
          {report?.accounts.length === 0 && <p className="text-sm text-muted-foreground">{t("oct19Core.coverage122")}</p>}
          {report?.accounts.map(account => <div key={account.id} className="space-y-2 border-b border-border pb-4 last:border-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><div className="font-medium">{account.name}</div><div className="text-xs text-muted-foreground">{account.shared ? t("oct19Core.coverage123") : account.ownerName ?? (account.ownerUserId ? t("oct19Core.coverage124") : t("oct19Core.coverage125"))} · {providerDisplayName(account.provider)} · {account.price.plan}</div></div>
              <div className="text-right"><div className="font-mono">{account.price.status !== "active" ? account.price.status === "ended" ? t("oct19Core.coverage126") : t("oct19Core.coverage127") : account.price.monthlyCents == null ? t("oct19Core.coverage128") : t("oct19Core.subscriptionMonthlyPrice", { amount: subscriptionMoney(account.price.monthlyCents, account.price.currency) })}</div><div className="text-xs text-muted-foreground">{account.price.source === "catalog" ? t("oct19Core.coverage129") : account.price.source === "user" ? t("oct19Core.coverage130") : ""}{account.price.cadence === "year" ? t("oct19Core.coverage131") : ""}</div></div>
            </div>
            <SubscriptionTokenUsage usage={account.usage} />
            {Number(account.usage.costCents) > 0 && <div className="text-xs text-muted-foreground">{t("oct19Core.subscriptionUsageCharges", { amount: formatCents(Number(account.usage.costCents)) })}</div>}
            {account.agents.length > 0 && <div className="text-xs text-muted-foreground">{t("oct19Core.subscriptionUsedBy", { names: account.agents.map(agent => agent.name).join(", ") })}</div>}
            {!account.identityVerified && <p className="text-xs text-muted-foreground">{t("oct19Core.coverage132")}</p>}
            {account.observedAt && <div className="text-xs text-muted-foreground">{t("oct19Core.subscriptionPlanChecked", { time: formatDateTime(account.observedAt) })}{account.refreshStatus === "unavailable" ? t("oct19Core.coverage133") : ""}</div>}
            {account.refreshStatus === "unavailable" && !account.observedAt && <p className="text-xs text-muted-foreground">{t("oct19Core.coverage134")}</p>}
            {account.canEdit && <div><Button variant="outline" size="sm" onClick={() => setEditing(account)}>{t("oct19Core.coverage135")}</Button></div>}
          </div>)}
          {!!report?.unattributedSubscription.eventCount && <p className="text-xs text-muted-foreground">{t("oct19Core.coverage136")}</p>}
          <p className="text-xs text-muted-foreground">{t("oct19Core.coverage137")}</p>
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}
