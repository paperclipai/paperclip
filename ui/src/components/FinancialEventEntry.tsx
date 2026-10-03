import { secretsApi } from "../api/secrets";
import { randomUuid } from "../lib/random-uuid";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFinanceEventSchema,
  importBillingInvoiceSchema,
  importProviderCostsSchema,
  usdToCents,
} from "@paperclipai/shared";
import { costsApi } from "../api/costs";
import { accountingApi } from "../api/accounting";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";

export function FinancialEventEntry({ companyId }: { companyId: string }) {
  return <Entry key={companyId} companyId={companyId} />;
}

function Entry({ companyId }: { companyId: string }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"record" | "invoice" | "provider">("record");
  const [biller, setBiller] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [credit, setCredit] = useState(false);
  const [invoice, setInvoice] = useState("");
  const [key, setKey] = useState(randomUuid);
  const [submittedCharge, setSubmittedCharge] = useState<Parameters<typeof costsApi.createFinanceEvent>[1] | null>(null);
  const [provider, setProvider] = useState<"openai" | "anthropic">("openai");
  const [secretId, setSecretId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [scopes, setScopes] = useState("");
  const [endDate, setEndDate] = useState(new Date().toISOString().slice(0, 10));
  const secrets = useQuery({
    queryKey: ["billing-credentials", companyId],
    queryFn: () => secretsApi.list(companyId),
    enabled: open && mode === "provider",
  });
  const [notice, setNotice] = useState("");
  const [validation, setValidation] = useState("");
  const action = useMutation({
    mutationFn: async () => {
      if (mode === "provider") {
        const input = importProviderCostsSchema.safeParse({
          provider,
          secretId,
          accountId,
          scopeIds: scopes
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          from: date,
          to: endDate,
        });
        if (!input.success) {
          setValidation(
            "Select an admin credential, account and project/workspace IDs, and up to 31 completed UTC days.",
          );
          return false;
        }
        await accountingApi.importProviderCosts(companyId, input.data);
      } else if (mode === "invoice") {
        let parsed;
        try {
          parsed = importBillingInvoiceSchema.parse(JSON.parse(invoice));
        } catch {
          setValidation(
            "Enter a valid invoice with biller, externalId, currency, and identified lines with amounts in cents.",
          );
          return false;
        }
        await accountingApi.importInvoice(companyId, parsed);
      } else {
        let parsed;
        try {
          parsed = submittedCharge ?? createFinanceEventSchema.parse({
            idempotencyKey: key,
            biller,
            amountCents: usdToCents(amount),
            description,
            currency: "USD",
            direction: credit ? "credit" : "debit",
            eventKind: credit ? "credit_refund" : "platform_fee",
            occurredAt: new Date(`${date}T00:00:00.000Z`).toISOString(),
          });
        } catch {
          setValidation(
            "Enter a provider, a nonnegative dollar amount, and a valid date.",
          );
          return false;
        }
        setSubmittedCharge(parsed);
        await costsApi.createFinanceEvent(companyId, parsed);
      }
      return true;
    },
    onSuccess: async (saved) => {
      if (!saved) return;
      setOpen(false);
      setKey(randomUuid());
      setSubmittedCharge(null);
      setAmount("");
      setInvoice("");
      setNotice(
        "Financial events saved. Adjust the date filter if they are outside this period.",
      );
      await client.invalidateQueries({
        predicate: (query) => query.queryKey.flat().includes(companyId),
      });
    },
  });
  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true);
          setValidation("");
          action.reset();
        }}
      >
        Record or import charges
      </Button>
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!action.isPending) setOpen(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Financial events</DialogTitle>
            <DialogDescription>
              Record a payment or import a provider invoice. These amounts stay
              separate from run-cost estimates.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setValidation("");
              action.mutate();
            }}
          >
            <div className="flex gap-2">
              <Button
                type="button"
                variant={mode === "record" ? "default" : "outline"}
                disabled={action.isPending || submittedCharge !== null}
                onClick={() => setMode("record")}
              >
                Record charge
              </Button>
              <Button
                type="button"
                variant={mode === "invoice" ? "default" : "outline"}
                disabled={action.isPending || submittedCharge !== null}
                onClick={() => setMode("invoice")}
              >
                Import invoice
              </Button>
              <Button
                type="button"
                variant={mode === "provider" ? "default" : "outline"}
                disabled={action.isPending || submittedCharge !== null}
                onClick={() => setMode("provider")}
              >
                Provider report
              </Button>
            </div>
            {mode === "record" ? (
              <>
                <label className="block space-y-2">
                  <span>Provider or biller</span>
                  <Input
                    value={biller}
                    onChange={(e) => setBiller(e.target.value)}
                    required
                    disabled={action.isPending || submittedCharge !== null}
                  />
                </label>
                <label className="block space-y-2">
                  <span>Amount (USD)</span>
                  <Input
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                    disabled={action.isPending || submittedCharge !== null}
                  />
                </label>
                <label className="block space-y-2">
                  <span>Date (UTC)</span>
                  <Input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                    disabled={action.isPending || submittedCharge !== null}
                  />
                </label>
                <label className="block space-y-2">
                  <span>Description</span>
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={500}
                    disabled={action.isPending || submittedCharge !== null}
                  />
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={credit}
                    onChange={(e) => setCredit(e.target.checked)}
                    disabled={action.isPending || submittedCharge !== null}
                  />
                  Credit or refund
                </label>
              </>
            ) : mode === "provider" ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Import API costs using a company admin credential saved in
                  Secrets. Select only projects or workspaces belonging to this
                  company. Reimporting records changes without duplicating
                  charges. Subscription payments require an invoice or manual
                  entry.
                </p>
                <label className="block space-y-2">
                  <span>Provider</span>
                  <select
                    value={provider}
                    onChange={(e) =>
                      setProvider(e.target.value as "openai" | "anthropic")
                    }
                    disabled={action.isPending}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </label>
                <label className="block space-y-2">
                  <span>Company admin credential</span>
                  <select
                    value={secretId}
                    onChange={(e) => setSecretId(e.target.value)}
                    required
                    disabled={action.isPending || secrets.isPending}
                  >
                    <option value="">Choose a saved secret</option>
                    {secrets.data
                      ?.filter((secret) => secret.scope === "company")
                      .map((secret) => (
                        <option key={secret.id} value={secret.id}>
                          {secret.name}
                        </option>
                      ))}
                  </select>
                </label>
                {secrets.isError && (
                  <p role="alert" className="text-sm text-destructive">
                    Could not load company credentials.
                  </p>
                )}
                <label className="block space-y-2">
                  <span>Provider organization ID</span>
                  <Input
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    required
                    disabled={action.isPending}
                  />
                </label>
                <label className="block space-y-2">
                  <span>
                    {provider === "openai" ? "Project IDs" : "Workspace IDs"}{" "}
                    (comma separated)
                  </span>
                  <Input
                    value={scopes}
                    onChange={(e) => setScopes(e.target.value)}
                    required
                    disabled={action.isPending}
                  />
                </label>
                <label className="block space-y-2">
                  <span>From (UTC)</span>
                  <Input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                    disabled={action.isPending}
                  />
                </label>
                <label className="block space-y-2">
                  <span>Until (UTC, exclusive)</span>
                  <Input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    required
                    disabled={action.isPending}
                  />
                </label>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Paste normalized invoice JSON. Stable invoice and line IDs
                  prevent duplicates. Amounts are decimal strings in cents;
                  dates use ISO format. Fees, credits and inference charges
                  appear in this timeline. Importing does not reprice runs.
                </p>
                <Textarea
                  aria-label="Financial invoice JSON"
                  value={invoice}
                  onChange={(e) => setInvoice(e.target.value)}
                  disabled={action.isPending}
                  placeholder={
                    '{"biller":"openai","externalId":"invoice-123","currency":"USD","lines":[{"externalId":"subscription","kind":"fee","amountCents":"2000","occurredAt":"2026-09-01T00:00:00Z"}]}'
                  }
                />
              </>
            )}
            {submittedCharge && !action.isPending && (
              <p role="status" className="text-sm text-muted-foreground">
                This charge may already be saved. Confirm the original charge before starting another entry. Confirmation will not duplicate it.
              </p>
            )}
            {(validation || action.isError) && (
              <p role="alert" className="text-sm text-destructive">
                {validation ||
                  "The charge could not be saved. Check your access and invoice identifiers, then retry."}
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="ghost"
                disabled={action.isPending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={action.isPending}>
                {action.isPending
                  ? "Saving…"
                  : mode === "record"
                    ? submittedCharge ? "Confirm original charge" : "Record charge"
                    : mode === "provider"
                      ? "Import provider report"
                      : "Import invoice"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
