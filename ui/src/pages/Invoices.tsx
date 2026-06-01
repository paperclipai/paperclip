import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Receipt, ExternalLink, Plus, X } from "lucide-react";
import { agnbPagesApi, type InvoiceRow } from "../api/agnbPages";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";

const inr = (paise: number | null) => (paise == null ? "—" : `₹${(paise / 100).toLocaleString("en-IN")}`);
function tone(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "paid") return "default";
  if (s === "cancelled") return "destructive";
  if (s === "expired") return "secondary";
  return "outline";
}
const STATUSES = ["all", "created", "paid", "expired", "cancelled"] as const;

export function Invoices() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Assets" }, { label: "Invoices" }]), [setBreadcrumbs]);
  const [status, setStatus] = useState<string>("all");
  const [showCreate, setShowCreate] = useState(false);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agnb.invoices,
    queryFn: () => agnbPagesApi.invoices(),
  });

  const rows: InvoiceRow[] = (data ?? []).filter((r) => status === "all" || r.status === status);

  return (
    <div className="space-y-4">
      <AgnbSubnav group="assets" />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Invoices</h1>
        <div className="flex flex-wrap items-center gap-1">
          {STATUSES.map((s) => (
            <button key={s} onClick={() => setStatus(s)}
              className={cn("rounded-md border px-2 py-0.5 text-xs capitalize",
                status === s ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
              {s}
            </button>
          ))}
          <Button size="sm" className="ml-1" onClick={() => setShowCreate(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> New invoice
          </Button>
        </div>
      </div>

      {showCreate && (
        <NewInvoiceModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            queryClient.invalidateQueries({ queryKey: queryKeys.agnb.invoices });
          }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Receipt} message="No invoices." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Invoice #</th><th className="p-2">Customer</th><th className="p-2 text-right">Subtotal</th><th className="p-2 text-right">GST</th><th className="p-2 text-right">Total</th><th className="p-2">Status</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/60">
                  <td className="p-2 font-mono text-xs">{r.invoice_number ?? "—"}</td>
                  <td className="p-2">
                    {r.customer_name}
                    {r.customer_email && <span className="block text-xs text-muted-foreground">{r.customer_email}</span>}
                  </td>
                  <td className="p-2 text-right font-mono">{inr(r.subtotal_paise)}</td>
                  <td className="p-2 text-right font-mono">{inr(r.gst_paise)}</td>
                  <td className="p-2 text-right font-mono font-semibold">{inr(r.total_paise)}</td>
                  <td className="p-2"><Badge variant={tone(r.status)}>{r.status}</Badge></td>
                  <td className="p-2">
                    {r.short_url && (
                      <a href={r.short_url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewInvoiceModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [f, setF] = useState({ customer_name: "", customer_email: "", customer_state: "", customer_gstin: "", subtotal_inr: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const subtotal = Number(f.subtotal_inr) || 0;
  const gst = Math.round(subtotal * 0.18);
  const total = subtotal + gst;

  const submit = async () => {
    if (!f.customer_name.trim()) { setErr("Customer name required"); return; }
    if (subtotal < 1) { setErr("Subtotal must be ≥ 1"); return; }
    setBusy(true); setErr(null);
    try {
      const r = await agnbPagesApi.createInvoice({
        customer_name: f.customer_name.trim(),
        customer_email: f.customer_email.trim() || undefined,
        customer_state: f.customer_state.trim() || undefined,
        customer_gstin: f.customer_gstin.trim() || undefined,
        subtotal_inr: subtotal,
        description: f.description.trim() || undefined,
      });
      if (r.rzp?.short_url) window.open(r.rzp.short_url, "_blank");
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">New invoice</h3>
          <button onClick={onClose}><X className="h-4 w-4 text-muted-foreground" /></button>
        </div>
        <div className="space-y-2">
          <Input placeholder="Customer legal name *" value={f.customer_name} onChange={set("customer_name")} />
          <Input placeholder="Email" value={f.customer_email} onChange={set("customer_email")} />
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="State (e.g. Karnataka)" value={f.customer_state} onChange={set("customer_state")} />
            <Input placeholder="GSTIN" value={f.customer_gstin} onChange={set("customer_gstin")} />
          </div>
          <Input type="number" placeholder="Subtotal ₹ (GST-exclusive) *" value={f.subtotal_inr} onChange={set("subtotal_inr")} />
          <Input placeholder="Description" value={f.description} onChange={set("description")} />
          {subtotal > 0 && (
            <p className="text-xs text-muted-foreground">
              Subtotal ₹{subtotal.toLocaleString("en-IN")} + GST 18% ₹{gst.toLocaleString("en-IN")} = <strong>₹{total.toLocaleString("en-IN")}</strong>
            </p>
          )}
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create & open link"}</Button>
        </div>
      </div>
    </div>
  );
}
