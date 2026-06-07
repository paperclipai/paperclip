import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Check, Trash2 } from "lucide-react";
import { renewalsApi } from "../api/agnbRenewals";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const KINDS = ["vendor", "compliance", "tax", "license", "insurance", "misc"];
const money = (paise: number | null, cur: string | null) => paise == null ? "—" : `${cur === "USD" ? "$" : "₹"}${(paise / 100).toLocaleString()}`;
function tone(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "renewed") return "default";
  if (s === "reminded") return "secondary";
  if (s === "cancelled") return "destructive";
  return "outline";
}

export function Renewals() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Renewals" }, { label: "Calendar" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.renewals, queryFn: () => renewalsApi.renewals() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.renewals });
  const renewed = async (id: string) => { await renewalsApi.patchRenewal(id, { status: "renewed" }).catch(() => {}); refresh(); };
  const del = async (id: string) => { await renewalsApi.deleteRenewal(id).catch(() => {}); refresh(); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Renewals</h1>
        <Button size="sm" onClick={() => setOpen(true)}>Add renewal</Button>
      </div>
      <AgnbSubnav group="renewals" />
      {open && (
        <AgnbFormModal
          title="Add renewal"
          fields={[
            { key: "name", label: "Name", required: true },
            { key: "kind", label: "Kind", type: "select", options: KINDS.map((k) => ({ value: k, label: k })) },
            { key: "vendor", label: "Vendor" },
            { key: "renewal_date", label: "Renewal date (YYYY-MM-DD)", required: true },
            { key: "amount_inr", label: "Amount (₹)", type: "number" },
          ]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await renewalsApi.createRenewal({ name: v.name, kind: v.kind || "misc", vendor: v.vendor || undefined, renewal_date: v.renewal_date, amount_paise: v.amount_inr ? Math.round(Number(v.amount_inr) * 100) : undefined, currency: "INR" }); refresh(); }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={CalendarClock} message="No renewals." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Name</th><th className="p-2">Kind</th><th className="p-2">Date</th><th className="p-2 text-right">Amount</th><th className="p-2">Status</th><th className="p-2"></th></tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} className="border-b border-border/60">
                  <td className="p-2">{r.name}{r.vendor && <span className="block text-[11px] text-muted-foreground">{r.vendor}</span>}</td>
                  <td className="p-2 text-xs text-muted-foreground">{r.kind}</td>
                  <td className="p-2 font-mono text-xs">{r.renewal_date}</td>
                  <td className="p-2 text-right font-mono">{money(r.amount_paise, r.currency)}</td>
                  <td className="p-2"><Badge variant={tone(r.status)}>{r.status}</Badge></td>
                  <td className="p-2"><div className="flex gap-1.5 text-muted-foreground">
                    {r.status !== "renewed" && <button title="Renewed" onClick={() => renewed(r.id)}><Check className="h-3.5 w-3.5 hover:text-emerald-600" /></button>}
                    <button title="Delete" onClick={() => del(r.id)}><Trash2 className="h-3.5 w-3.5 hover:text-destructive" /></button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
