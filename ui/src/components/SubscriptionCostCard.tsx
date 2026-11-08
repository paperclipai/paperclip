import { t, useTranslation, Trans } from "@/i18n";
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
    : new Intl.NumberFormat(undefined, { style: "currency", currency, currencyDisplay: "code" }).format(Number(cents) / 100);
}

export function SubscriptionTokenUsage({ usage }: { usage: SubscriptionUsage }) {
  useTranslation("task-components");
  return <span className="font-mono text-xs text-muted-foreground">
    {t("final-components-a:inputInOutputOut_f8687cf4", { input: formatTokens(usage.inputTokens + usage.cachedInputTokens), output: formatTokens(usage.outputTokens) })}
    {usage.cachedInputTokens > 0 && <span className="block"><Trans ns="task-components" i18nKey="sentence_c358d572531f" components={{ part1: <>{formatTokens(usage.cachedInputTokens)}</> }} /></span>}
  </span>;
}

function SubscriptionEditor({ account, accounts, companyId, onDone }: {
  account: SubscriptionAccountReport; accounts: SubscriptionAccountReport[]; companyId: string; onDone: () => void;
}) {
  useTranslation("task-components");
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
      <div className="space-y-2"><Label htmlFor="subscription-plan">{t("task-components:plan_fa8ed0bd")}</Label><Input id="subscription-plan" value={plan} onChange={event => setPlan(event.target.value)} required maxLength={100} /></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="subscription-price">{t("task-components:pricePerBillingPeriod_7dbebe10")}</Label><Input id="subscription-price" type="number" min="0" step="any" value={amount} placeholder={t("task-components:unknown_b764cdc0")} onChange={event => setAmount(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="subscription-currency">{t("task-components:currency_3ac1a9ec")}</Label><select id="subscription-currency" className={selectClass} value={currency} onChange={event => setCurrency(event.target.value)}>{SUBSCRIPTION_CURRENCIES.map(code => <option key={code}>{code}</option>)}</select></div>
        <div className="space-y-2"><Label htmlFor="subscription-cadence">{t("task-components:billed_b3a9f29f")}</Label><select id="subscription-cadence" className={selectClass} value={cadence} onChange={event => setCadence(event.target.value as typeof cadence)}><option value="month">{t("task-components:monthly_9b11f6b7")}</option><option value="year">{t("task-components:annually_1ec9d1d5")}</option></select></div>
        <div className="space-y-2"><Label htmlFor="subscription-status">{t("task-components:tracking_36b6ca18")}</Label><select id="subscription-status" className={selectClass} value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="active">{t("task-components:active_92340695")}</option><option value="ended">{t("task-components:subscriptionEnded_5048e351")}</option><option value="excluded">{t("task-components:excludeFromThisOrganization_eb7eb015")}</option></select></div>
      </div>
      <p className="text-xs text-muted-foreground">{t("task-components:enterTheFullAmountForOneAccount_ef0679af")}</p>
      {save.error && <p role="alert" className="text-sm text-destructive">{t("task-components:couldNotSaveThisPriceCheckThe_fd0a8b51")}</p>}
      <div className="flex items-center justify-between"><Button type="button" variant="ghost" disabled={busy} onClick={onDone}>{t("task-components:cancel_19766ed6")}</Button><Button type="submit" disabled={busy}>{save.isPending ? t("task-components:saving_23e39291") : t("task-components:savePrice_3ae1d715")}</Button></div>
    </form>
    {targets.length > 0 && <div className="space-y-2 border-t border-border pt-4">
      <Label htmlFor="subscription-link">{t("task-components:sameSubscriptionAsAnotherAccount_6d632248")}</Label>
      <select id="subscription-link" className={selectClass} value={targetId} onChange={event => setTargetId(event.target.value)}><option value="">{t("task-components:chooseAnAccount_0e4dbf48")}</option>{targets.map(row => <option key={row.id} value={row.id}>{row.name} · {row.price.plan}</option>)}</select>
      <p className="text-xs text-muted-foreground">{t("task-components:linkingCountsTheseAccountsOnceCombinesTheir_e3bd59a0")}</p>
      {link.error && <p role="alert" className="text-sm text-destructive">{t("task-components:couldNotLinkTheseAccountsReopenTheir_e6091b82")}</p>}
      <Button type="button" variant="outline" disabled={!targetId || busy} onClick={() => link.mutate()}>{t("task-components:linkAccounts_5f1d8bf6")}</Button>
    </div>}
  </div>;
}

export function SubscriptionCostCard({ companyId, report, error, onChanged }: {
  companyId: string; report?: SubscriptionCostReport; error?: unknown; onChanged: () => void;
}) {
  useTranslation("task-components");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SubscriptionAccountReport | null>(null);
  const closeEditor = () => { setEditing(null); onChanged(); };
  const known = report?.monthlyTotals.length;
  const estimatedCount = report?.monthlyTotals.reduce((sum, total) => sum + total.estimatedCount, 0) ?? 0;
  return <>
    <Card className="block p-4">
      <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("task-components:subscriptions_a151f2e9")}</div>
      <div className="mt-2 font-mono text-2xl font-semibold tabular-nums">
        {known ? report!.monthlyTotals.map(total => <div key={total.currency}>{subscriptionMoney(total.amountCents, total.currency)}<span className="text-sm font-normal">{t("task-components:month_eec5d08b")}</span></div>) : report && report.activeCount === 0 && report.accounts.length > 0 ? t("task-components:000Month_e5e2e135") : "—"}
      </div>
      <div className="mt-1 space-y-1 text-xs text-muted-foreground">
        {report ? <>
          {estimatedCount > 0 && <div><Badge variant="outline" className="font-normal text-muted-foreground">{estimatedCount < report.activeCount - report.unknownPriceCount ? t("task-components:partiallyEstimated_4178459d") : t("final-components-a:estimated_b774599a")}</Badge></div>}
          {report.unknownPriceCount > 0 && !!known && <div>{t("task-components:knownMonthlySubtotal_2920eb5c")}</div>}
          <div>{report.accounts.length === 0 ? t("task-components:noVisibleSubscriptions_d31142aa") : <><Trans ns="final-components-a" i18nKey="numeric_3e48a1476e3c" values={{ activeCount: report.activeCount }} components={{ part2: <>{report.activeCount === 1 ? t("task-components:subscription_a8fa7fd6") : t("task-components:subscriptions_9cac91c1")}</>, part3: <>{report.unknownPriceCount > 0 && t("final-components-a:unknownPrices", { count: report.unknownPriceCount })}</> }} /></>}</div>
          {report.accounts.length > 0 && <div>{t("task-components:monthlyFeesForAccountsVisibleToYou_44398b73")}</div>}
          {report.unidentifiedAccountCount > 0 && <div><Trans ns="final-components-a" i18nKey="numeric_8d89705dde02" values={{ unidentifiedAccountCount: report.unidentifiedAccountCount }} components={{ part2: <>{report.unidentifiedAccountCount === 1 ? t("task-components:accountIdentity_abdd1e9d") : t("task-components:accountIdentities_dede4eae")}</> }} /></div>}
          <SubscriptionTokenUsage usage={report.subscription} />
        </> : error ? <div>{t("task-components:subscriptionDataIsUnavailable_04322215")}</div> : <div>{t("task-components:loadingSubscriptions_d98d84b2")}</div>}
        {report && error ? <div>{t("task-components:showingLastLoadedSubscriptionData_dc480d4f")}</div> : null}
      </div>
      <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setOpen(true)} disabled={!report}>{t("task-components:viewDetails_d1bf045b")}</Button>
    </Card>
    <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) setEditing(null); }}>
      <DialogContent className="max-h-(--sz-80vh) overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>{editing ? t("task-components:subscriptionPrice_c0c1679b") : t("task-components:subscriptions_a151f2e9")}</DialogTitle><DialogDescription>{t("task-components:currentMonthlyCostsForAccountsVisibleTo_c73e1136")}</DialogDescription></DialogHeader>
        {editing ? <SubscriptionEditor key={editing.id} companyId={companyId} account={editing} accounts={report?.accounts ?? []} onDone={closeEditor} /> : <div className="space-y-4">
          {report?.accounts.length === 0 && <p className="text-sm text-muted-foreground">{t("task-components:noSubscriptionsAreVisibleToYouYet_c0ee05c7")}</p>}
          {report?.accounts.map(account => <div key={account.id} className="space-y-2 border-b border-border pb-4 last:border-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><div className="font-medium">{account.name}</div><div className="text-xs text-muted-foreground">{account.shared ? t("task-components:shared_e3c4b39d") : account.ownerName ?? (account.ownerUserId ? t("task-components:accountOwner_801ba134") : t("task-components:personalAccounts_66d74d1a"))} · {providerDisplayName(account.provider)} · {account.price.plan}</div></div>
              <div className="text-right"><div className="font-mono">{account.price.status !== "active" ? account.price.status === "ended" ? t("task-components:ended_7cdc804e") : t("task-components:excluded_bef1fd9e") : account.price.monthlyCents == null ? t("task-components:priceUnknown_d7ffab45") : t("task-components:month_c2204659", { value1: subscriptionMoney(account.price.monthlyCents, account.price.currency) })}</div><div className="text-xs text-muted-foreground">{account.price.source === "catalog" ? t("task-components:estimatedBeforeTax_f79d3c1d") : account.price.source === "user" ? t("task-components:userSupplied_b4a10447") : ""}{account.price.cadence === "year" ? (" " + t("task-components:annualPayment12_d8170fed")) : ""}</div></div>
            </div>
            <SubscriptionTokenUsage usage={account.usage} />
            {Number(account.usage.costCents) > 0 && <div className="text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_28e3a25e1a3b" components={{ part1: <>{formatCents(Number(account.usage.costCents))}</> }} /></div>}
            {account.agents.length > 0 && <div className="text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_f0726b155def" components={{ part1: <>{account.agents.map(agent => agent.name).join(", ")}</> }} /></div>}
            {!account.identityVerified && <p className="text-xs text-muted-foreground">{t("task-components:accountIdentityIsUnconfirmedLinkDuplicatesIf_bed36668")}</p>}
            {account.observedAt && <div className="text-xs text-muted-foreground">{t("final-components-a:planCheckedTime_4a6e4573", { time: formatDateTime(account.observedAt) })}{account.refreshStatus === "unavailable" ? (" " + t("task-components:latestCheckUnavailable_ade31b9c")) : ""}</div>}
            {account.refreshStatus === "unavailable" && !account.observedAt && <p className="text-xs text-muted-foreground">{t("task-components:theProviderDidNotMakePlanDetails_e7ca998b")}</p>}
            {account.canEdit && <div><Button variant="outline" size="sm" onClick={() => setEditing(account)}>{t("task-components:editPrice_75ac63a6")}</Button></div>}
          </div>)}
          {!!report?.unattributedSubscription.eventCount && <p className="text-xs text-muted-foreground">{t("task-components:someSubscriptionUsageHasNoRecordedAccount_cd467c7c")}</p>}
          <p className="text-xs text-muted-foreground">{t("task-components:monthlyFeesCoverTheWholeAccountIncluding_6311f5d2")}</p>
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}
