import { useEffect } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const CATALOG: Array<{ type: string; description: string; fires_when: string; bucket_scoped: boolean }> = [
  { type: "experiment.verdict_changed", description: "Bayesian verdict flips", fires_when: "verdict recomputed and changed", bucket_scoped: true },
  { type: "bucket.status_changed", description: "Bucket status transition", fires_when: "proposed→running→paused→concluded", bucket_scoped: true },
  { type: "bucket.target_breached", description: "Reply-rate below target", fires_when: "compound_reply_rate < target after min sends", bucket_scoped: true },
  { type: "bucket.dispatch_requested", description: "Dispatch to Rocket requested", fires_when: "operator/auto requests send", bucket_scoped: true },
  { type: "bucket.campaign_linked", description: "Rocket campaign linked", fires_when: "campaign linked to bucket", bucket_scoped: true },
  { type: "bucket.promoted", description: "Winning variant promoted", fires_when: "win verdict → promotion", bucket_scoped: true },
  { type: "bucket.fatigue_detected", description: "Audience fatigue", fires_when: "reply decay detected", bucket_scoped: true },
  { type: "attribution.meeting_booked", description: "Meeting booked", fires_when: "Cal/HubSpot meeting attributed", bucket_scoped: false },
  { type: "attribution.deal_won", description: "Deal won", fires_when: "HubSpot deal closed-won attributed", bucket_scoped: false },
  { type: "deal.stage_changed", description: "Pipeline stage move", fires_when: "HubSpot deal stage changes", bucket_scoped: false },
];

export function WebhooksCatalog() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Ops" }, { label: "Event catalog" }]), [setBreadcrumbs]);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Event catalog</h1>
      <AgnbSubnav group="ops" />
      <p className="text-xs text-muted-foreground">Events AGNB emits for outbound webhook subscriptions.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {CATALOG.map((e) => (
          <Card key={e.type}><CardContent className="p-3">
            <div className="flex items-center justify-between gap-2"><span className="font-mono text-sm">{e.type}</span>{e.bucket_scoped && <Badge variant="outline">bucket</Badge>}</div>
            <div className="mt-1 text-xs">{e.description}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">fires: {e.fires_when}</div>
          </CardContent></Card>
        ))}
      </div>
    </div>
  );
}
