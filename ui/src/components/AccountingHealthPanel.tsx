import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUsdExact, importBillingInvoiceSchema, type AccountingInspection } from "@paperclipai/shared";
import { accountingApi } from "../api/accounting";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** Company key remounts review state so a review can never follow the operator
 * into another company. Mutations always use the company captured at review. */
export function AccountingHealthPanel({ companyId }: { companyId: string }) {
  return <AccountingPanel key={companyId} companyId={companyId} />;
}
function AccountingPanel({ companyId }: { companyId: string }) {
  const client = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [inspection, setInspection] = useState<AccountingInspection | null>(null);
  const [repairReason, setRepairReason] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [invoiceJson, setInvoiceJson] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [notice, setNotice] = useState("");
  const health = useQuery({ queryKey: ["accounting", companyId, "health"], queryFn: () => accountingApi.health(companyId), refetchInterval: 30_000 });
  const invoices = useQuery({ queryKey: ["accounting", companyId, "invoices"], queryFn: () => accountingApi.invoices(companyId), enabled: expanded });
  const report = useQuery({ queryKey: ["accounting", companyId, "invoice", invoiceId], queryFn: () => accountingApi.reconcile(companyId, invoiceId), enabled: expanded && !!invoiceId });
  const action = useMutation({ mutationFn: async (work: () => Promise<void>) => { setNotice(""); await work(); },
    onSuccess: async () => { await client.invalidateQueries(); } });
  const run = (work: () => Promise<void>) => action.mutate(work);
  const error = action.error ?? health.error ?? invoices.error ?? report.error;
  return <Card>
    <CardHeader>
      <CardTitle>Accounting health</CardTitle>
      <CardDescription>Receipt recovery, budget capacity, and provider invoice reconciliation.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      {error && <p role="alert" className="text-sm text-destructive">{error instanceof Error ? error.message : "Accounting request failed"}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {health.isPending && <p className="text-sm text-muted-foreground">Loading accounting health…</p>}
      {health.data && <div className="flex flex-wrap gap-4 text-sm">
        <span>{health.data.pendingRunCount} pending runs</span><span>{health.data.unpricedEventCount} unpriced charges</span>
        <span>{health.data.pendingCancellationCount} pending budget stops</span><span>{formatUsdExact(health.data.heldReservationCents)} reserved</span>
        {health.data.oldestPendingAt && <span>Oldest pending: {new Date(health.data.oldestPendingAt).toLocaleString()}</span>}
      </div>}
      <Button variant="outline" onClick={() => setExpanded(!expanded)}>{expanded ? "Hide accounting tools" : "Open accounting tools"}</Button>
      {expanded && <div className="space-y-4">
        {health.data?.items.map(item => <div key={item.costEventId ?? item.runId} className="space-y-2 border-t pt-3 text-sm">
          <p>{item.state.replaceAll("_", " ")} · {item.runId ?? item.costEventId}</p>
          <p className="text-muted-foreground">Since {new Date(item.since).toLocaleString()} · {item.attempts} recovery attempts</p>
          {item.lastError && <p>{item.lastError}</p>}
          {item.state === "waiting_for_receipt" && <p>Waiting for provider evidence. Recovery will not invent a zero charge.</p>}
          {item.state === "unpriced" && <p>Import a provider invoice below to review and price this charge.</p>}
          {item.state === "retryable" && item.runId && <Button variant="outline" disabled={action.isPending} onClick={() => run(async () => {
            const result = await accountingApi.retry(companyId, item.runId!); setNotice(result.accounted ? "Receipt accounted." : "Receipt is still awaiting evidence.");
          })}>Retry accounting</Button>}
        </div>)}
        <div className="space-y-3 border-t pt-4">
          <Button disabled={action.isPending} onClick={() => run(async () => { setInspection(await accountingApi.inspect(companyId)); })}>Inspect stored totals</Button>
          {inspection && <>
            <p className="text-sm">{inspection.findings.length} findings. Repairs only rebuild totals supported by the ledger.</p>
            {inspection.findings.map(f => <div className="text-sm" key={`${f.kind}:${f.entityId}`}>
              <p>{f.kind.replaceAll("_", " ")} · {f.entityId} · {f.repairable ? "Repair available" : "Evidence required"}</p>
              {Object.keys(f.expected).map(key => <p className="text-muted-foreground" key={key}>{key}: {f.actual[key]} → {f.expected[key]}</p>)}
            </div>)}
            {inspection.findings.some(f => f.repairable) && <>
              <Input aria-label="Accounting repair reason" placeholder="Reason for repair" value={repairReason} onChange={e => setRepairReason(e.target.value)} />
              <Button disabled={action.isPending || !repairReason.trim()} onClick={() => run(async () => {
                setInspection(await accountingApi.repair(companyId, inspection.fingerprint, repairReason)); setNotice("Reviewed totals repaired. An audit entry records the change.");
              })}>Repair reviewed totals</Button>
            </>}
          </>}
        </div>
        <div className="space-y-3 border-t pt-4">
          <p className="font-medium">Provider invoices</p>
          <p className="text-sm text-muted-foreground">Import normalized invoice JSON with biller, externalId, currency, and lines. Each line needs externalId, amountCents, occurredAt, and a costEventId, runId, or providerRequestId for matching. Decimal amounts are strings in cents. Fees and credits remain separate from inference charges.</p>
          <Textarea aria-label="Invoice JSON" value={invoiceJson} onChange={e => setInvoiceJson(e.target.value)} placeholder='{"biller":"anthropic","externalId":"invoice-123","currency":"USD","lines":[]}' />
          <Button disabled={action.isPending || !invoiceJson.trim()} onClick={() => run(async () => {
            const parsed = importBillingInvoiceSchema.parse(JSON.parse(invoiceJson));
            const invoice = await accountingApi.importInvoice(companyId, parsed); setInvoiceId(invoice.id); setCorrectionReason(""); setInvoiceJson(""); setNotice("Invoice imported. Review differences before applying a correction.");
          })}>Import invoice for review</Button>
          <div className="flex flex-wrap gap-2">{invoices.data?.map(invoice => <Button variant="outline" key={invoice.id} onClick={() => { setInvoiceId(invoice.id); setCorrectionReason(""); }}>{invoice.biller} · {invoice.externalId}</Button>)}</div>
          {report.data && <>
            <Input aria-label="Invoice correction reason" placeholder="Reason for applying a correction" value={correctionReason} onChange={e => setCorrectionReason(e.target.value)} />
            {report.data.lines.map(line => <div key={line.id} className="space-y-2 border-t pt-3 text-sm">
              <p>{line.externalId} · {line.status.replaceAll("_", " ")} · {line.amountCents} {report.data!.invoice.currency} cents</p>
              {line.recordedCents !== null && <p>Recorded: {line.recordedCents} cents · Difference: {line.differenceCents} cents</p>}
              {line.status === "difference" && line.matchedEventId && line.recordedCents !== null && <Button variant="outline" disabled={action.isPending || !correctionReason.trim()} onClick={() => run(async () => {
                await accountingApi.adjust(companyId, line.matchedEventId!, { idempotencyKey: `invoice-line:${line.id}`, invoiceLineId: line.id,
                  expectedCents: line.recordedCents!, correctedCents: line.amountCents, reason: correctionReason,
                  pricing: { source: "provider_invoice", evidence: report.data!.invoice.externalId } });
                setNotice("Correction recorded. The original provider charge remains in the audit history.");
              })}>Apply reviewed correction</Button>}
            </div>)}
          </>}
        </div>
      </div>}
    </CardContent>
  </Card>;
}
