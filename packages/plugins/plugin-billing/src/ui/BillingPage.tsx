import { useEffect, useState } from "react";
import {
  Spinner,
  StatusBadge,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  type PluginCompanySettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { formatAmount } from "../format.js";
import type { BillingSummary } from "../service.js";
import { ActionRow, Button, Callout, Card, CardBody, CardHeader, LoadingBlock, Mono, PageHeading, PropRow, Stack } from "./kit.js";

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

export function BillingPage({ context }: PluginCompanySettingsPageProps) {
  const companyId = context.companyId ?? "";
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const search = new URLSearchParams(location.search);
  const returnedSession = search.get("checkout") === "success" ? search.get("session") : null;

  const [tick, setTick] = useState(0);
  const [confirming, setConfirming] = useState(returnedSession !== null);
  const [confirmSlow, setConfirmSlow] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: summary, loading, error: loadError } = usePluginData<BillingSummary>("billing-summary", { companyId, tick });
  const createCheckout = usePluginAction("create-checkout");
  const resolveCheckout = usePluginAction("resolve-checkout");
  const oneClick = usePluginAction("one-click-subscribe");
  const cancel = usePluginAction("cancel-at-period-end");
  const resume = usePluginAction("resume-subscription");

  // Confirming payment…: server-side resolveCheckout first (sub-second), then
  // brief polling; after ~20s fall back to "taking longer than expected" —
  // the webhook + sweep reconcile and this page re-polls (spec §6.3).
  useEffect(() => {
    if (!confirming || !returnedSession) return;
    let cancelled = false;
    void resolveCheckout({ companyId, sessionRef: returnedSession }).catch(() => {});
    let interval = setInterval(() => {
      if (!cancelled) setTick((value) => value + 1);
    }, 2000);
    const slowTimer = setTimeout(() => {
      if (!cancelled) {
        setConfirmSlow(true);
        // Back off from 2s to 15s polling after slow threshold
        clearInterval(interval);
        interval = setInterval(() => {
          if (!cancelled) setTick((value) => value + 1);
        }, 15000);
      }
    }, 20000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(slowTimer);
    };
  }, [confirming, returnedSession, companyId, resolveCheckout]);

  useEffect(() => {
    if (confirming && summary && (summary.status === "active" || summary.status === "complimentary")) {
      setConfirming(false);
    }
  }, [confirming, summary]);

  if (loading && !summary) return <LoadingBlock><Spinner /></LoadingBlock>;
  if (!summary) {
    return (
      <Callout tone="danger" role="alert">
        <span>Billing information is unavailable{loadError ? `: ${loadError.message}` : "."}</span>
      </Callout>
    );
  }

  const price = `${formatAmount(summary.priceCents, summary.currency)}/month`;

  async function run(action: () => Promise<unknown>): Promise<void> {
    setActionError(null);
    try {
      await action();
      setTick((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function startCheckout(): Promise<void> {
    await run(async () => {
      const result = (await createCheckout({ companyId })) as { url: string };
      if (/^https?:\/\//.test(result.url)) window.location.assign(result.url);
      else navigation.navigate(result.url);
    });
  }

  async function startOneClick(): Promise<void> {
    await run(async () => {
      const result = (await oneClick({ companyId })) as { status: string; url?: string };
      if (result.status === "requires_action" && result.url) {
        if (/^https?:\/\//.test(result.url)) window.location.assign(result.url);
        else navigation.navigate(result.url);
      }
    });
  }

  const subscribeCta = summary.hasDefaultPaymentMethod ? (
    <ActionRow>
      <Button variant="primary" onClick={() => void startOneClick()}>
        Add subscription for {formatAmount(summary.priceCents, summary.currency)}/month — uses card on file
      </Button>
      <Button variant="ghost" onClick={() => void startCheckout()}>Use a different payment method</Button>
    </ActionRow>
  ) : (
    <Button variant="primary" onClick={() => void startCheckout()}>Subscribe now — {price}</Button>
  );

  return (
    <Stack style={{ maxWidth: 720 }}>
      <PageHeading>Billing</PageHeading>

      {confirming && (
        <Callout tone="info" role="status">
          <Spinner />
          <span>
            <span>Confirming payment…</span>
            {confirmSlow && (
              <span style={{ display: "block", marginTop: 4 }}>
                This is taking longer than expected — we&apos;ll update this page automatically.
              </span>
            )}
          </span>
        </Callout>
      )}

      {actionError && <Callout tone="danger" role="alert"><span>{actionError}</span></Callout>}

      <Card>
        <CardHeader
          title="Subscription"
          right={
            <StatusBadge
              label={summary.status}
              status={
                summary.status === "active" || summary.status === "complimentary"
                  ? "ok"
                  : summary.status === "grace" || summary.status === "trialing" || summary.status === "awaiting_payment"
                    ? "warning"
                    : "error"
              }
            />
          }
        />
        <CardBody>
          <PropRow label="Price" value={summary.status === "complimentary" ? "Complimentary" : price} />
          {summary.status === "trialing" && (
            <PropRow label="Free trial" value={`Free trial — ends ${day(summary.trialEndsAt)}`} />
          )}
          {summary.currentPeriodEnd && summary.status === "active" && (
            <PropRow
              label={summary.cancelAtPeriodEnd ? "Ends" : "Renews"}
              value={summary.cancelAtPeriodEnd ? `Ends on ${day(summary.currentPeriodEnd)}` : `Renews on ${day(summary.currentPeriodEnd)}`}
            />
          )}
          {summary.status === "grace" && (
            <PropRow label="Grace period" value={`Payment issue — resolve by ${day(summary.graceDeadline)} to keep agents running.`} />
          )}
        </CardBody>
      </Card>

      {(summary.status === "trialing" ||
        summary.status === "awaiting_payment" ||
        summary.status === "grace" ||
        summary.status === "blocked" ||
        summary.status === "canceled" ||
        summary.status === "active") && (
        <Card>
          <CardBody>
            <Stack gap={12}>
              {summary.status === "awaiting_payment" && (
                <Callout tone="warning">
                  <span>This company needs a subscription before agents can run.</span>
                </Callout>
              )}
              {summary.status === "blocked" && (
                <Callout tone="danger">
                  <span>Agent runs are paused until this company has an active subscription.</span>
                </Callout>
              )}
              {summary.status === "trialing" && subscribeCta}
              {summary.status === "awaiting_payment" && subscribeCta}
              {summary.status === "grace" && subscribeCta}
              {summary.status === "blocked" && subscribeCta}
              {summary.status === "canceled" && (
                <Button variant="primary" onClick={() => void startCheckout()}>Resubscribe — {price}</Button>
              )}
              {summary.status === "active" && !summary.cancelAtPeriodEnd && (
                <Button variant="default" onClick={() => void run(() => cancel({ companyId }))}>Cancel at period end</Button>
              )}
              {summary.status === "active" && summary.cancelAtPeriodEnd && (
                <Button variant="primary" onClick={() => void run(() => resume({ companyId }))}>Resume subscription</Button>
              )}
            </Stack>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="History" />
        <CardBody padding={0}>
          {summary.events.length === 0 ? (
            <div style={{ padding: "16px" }}>
              <span style={{ fontSize: 13 }}>No billing events yet.</span>
            </div>
          ) : (
            <div>
              {summary.events.map((event, index) => (
                <div
                  key={`${event.type}-${index}`}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                    padding: "10px 16px",
                    borderTop: index === 0 ? "none" : "1px solid var(--border, oklch(0.269 0 0))",
                    fontSize: 13,
                  }}
                >
                  <Mono>{event.type}</Mono>
                  <span style={{ color: "var(--muted-foreground, oklch(0.708 0 0))", fontSize: 12 }}>
                    {event.createdAt.slice(0, 19).replace("T", " ")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </Stack>
  );
}
