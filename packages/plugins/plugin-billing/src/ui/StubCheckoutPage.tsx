import { useState } from "react";
import {
  Spinner,
  useHostLocation,
  useHostNavigation,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { formatAmount } from "../format.js";
import type { StubSession } from "../provider/stub.js";
import { ActionRow, Button, Callout, Card, CardBody, CardHeader, LoadingBlock, PageHeading, PropRow, Stack, tokens } from "./kit.js";

export function StubCheckoutPage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? "";
  const location = useHostLocation();
  const navigation = useHostNavigation();
  const sessionRef = new URLSearchParams(location.search).get("session") ?? "";

  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [savePaymentMethod, setSavePaymentMethod] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: session, loading, error: loadError } = usePluginData<StubSession | null>("stub-session", { companyId, sessionRef, tick });
  const act = usePluginAction("stub-checkout-complete");

  if (!sessionRef) return <Callout tone="warning">Missing checkout session reference.</Callout>;
  if (loading && !session) return <LoadingBlock><Spinner /></LoadingBlock>;
  if (!session) {
    return (
      <Callout tone="danger" role="alert">
        <span>
          {loadError ? `Could not load this checkout session: ${loadError.message}` : "This checkout session does not exist."}
        </span>
      </Callout>
    );
  }

  async function submit(outcome: "pay" | "fail" | "cancel"): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await act({ companyId, sessionRef, outcome, savePaymentMethod });
      if (outcome === "pay" && session!.successUrl) navigation.navigate(session!.successUrl);
      else if (outcome === "cancel" && session!.cancelUrl) navigation.navigate(session!.cancelUrl);
      else setTick((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack style={{ maxWidth: 520 }}>
      <PageHeading>Checkout</PageHeading>
      <p style={{ margin: 0, fontSize: 13, color: tokens.muted }}>
        This is the stub payment simulator — no real money moves. It exercises the exact production path: signed webhook → ledger → transition → standing.
      </p>

      <Card>
        <CardHeader title="Order summary" />
        <CardBody>
          <PropRow label="Amount" value={`${formatAmount(session.priceCents, session.currency)}/month`} />
          {session.trialEndsAtIso && (
            <PropRow label="Trial" value={`Billing starts ${session.trialEndsAtIso.slice(0, 10)} (remaining trial preserved)`} />
          )}
        </CardBody>
      </Card>

      {session.status !== "open" && <Callout tone="info"><span>This session is {session.status}.</span></Callout>}
      {session.lastError === "card_declined" && (
        <Callout tone="danger" role="alert"><span>The card was declined. Try again or cancel.</span></Callout>
      )}
      {error && <Callout tone="danger" role="alert"><span>{error}</span></Callout>}

      {session.status === "open" && (
        <Card>
          <CardBody>
            <Stack gap={14}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={savePaymentMethod}
                  onChange={(event) => setSavePaymentMethod(event.target.checked)}
                />
                Save payment method for one-click subscriptions
              </label>
              <ActionRow>
                <Button variant="primary" disabled={busy} onClick={() => void submit("pay")}>
                  Pay {formatAmount(session.priceCents, session.currency)}
                </Button>
                <Button variant="default" disabled={busy} onClick={() => void submit("fail")}>Simulate failed payment</Button>
                <Button variant="ghost" disabled={busy} onClick={() => void submit("cancel")}>Cancel</Button>
              </ActionRow>
            </Stack>
          </CardBody>
        </Card>
      )}
    </Stack>
  );
}
