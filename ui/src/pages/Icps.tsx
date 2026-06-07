import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Crosshair } from "lucide-react";
import { campaignsApi, type IcpRow } from "../api/agnbCampaigns";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const TIERS: Array<IcpRow["tier"]> = ["now", "later", "monitor"];
const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function Icps() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Campaigns" }, { label: "ICPs" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.icps, queryFn: () => campaignsApi.icps() });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">ICPs</h1>
        <Button size="sm" onClick={() => setOpen(true)}>New ICP</Button>
      </div>
      <AgnbSubnav group="campaigns" />
      {open && (
        <AgnbFormModal
          title="New ICP"
          fields={[
            { key: "name", label: "Name", required: true },
            { key: "tier", label: "Tier", type: "select", options: [{ value: "now", label: "now" }, { value: "later", label: "later" }, { value: "monitor", label: "monitor" }] },
            { key: "industries", label: "Industries (comma)" },
            { key: "regions", label: "Regions (comma)" },
            { key: "functions", label: "Functions (comma)" },
            { key: "company_size_min", label: "Company size min", type: "number" },
            { key: "company_size_max", label: "Company size max", type: "number" },
          ]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => {
            await campaignsApi.createIcp({
              name: v.name, tier: v.tier || "monitor",
              industries: csv(v.industries), regions: csv(v.regions), functions: csv(v.functions),
              company_size_min: v.company_size_min ? Number(v.company_size_min) : null,
              company_size_max: v.company_size_max ? Number(v.company_size_max) : null,
            });
            qc.invalidateQueries({ queryKey: queryKeys.agnb.icps });
          }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={Crosshair} message="No ICPs." />
      ) : (
        <div className="space-y-4">
          {TIERS.map((tier) => {
            const tierIcps = data.filter((i) => i.tier === tier);
            if (!tierIcps.length) return null;
            return (
              <div key={tier}>
                <h2 className="mb-1 text-sm font-medium capitalize text-muted-foreground">{tier}</h2>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {tierIcps.map((i) => (
                    <Card key={i.id}><CardContent className="p-3">
                      <div className="flex items-center gap-2"><span className="font-medium">{i.name}</span><Badge variant="outline">{i.tier}</Badge></div>
                      {(i.industries?.length ?? 0) > 0 && <div className="mt-1 text-xs text-muted-foreground">{i.industries!.join(", ")}</div>}
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {(i.company_size_min || i.company_size_max) ? `${i.company_size_min ?? "?"}–${i.company_size_max ?? "?"} emp · ` : ""}
                        {(i.regions ?? []).join(", ")}
                      </div>
                      {(i.functions?.length ?? 0) > 0 && <div className="mt-0.5 text-[11px] text-muted-foreground">{i.functions!.slice(0, 3).join(", ")}{i.functions!.length > 3 ? "…" : ""}</div>}
                    </CardContent></Card>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
