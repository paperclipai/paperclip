import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Receipt, ExternalLink } from "lucide-react";
import { agnbPagesApi, type InvoiceRow } from "../api/agnbPages";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
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

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.agnb.invoices,
    queryFn: () => agnbPagesApi.invoices(),
  });

  const rows: InvoiceRow[] = (data ?? []).filter((r) => status === "all" || r.status === status);

  return (
    <div className="space-y-4">
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
        </div>
      </div>
      <AgnbSubnav group="assets" />

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
