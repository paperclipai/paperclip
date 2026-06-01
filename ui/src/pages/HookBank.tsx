import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Anchor } from "lucide-react";
import { linkedinQueueApi } from "../api/agnbLinkedinQueue";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "../lib/utils";

const ANGLES = ["all", "contrarian", "personal", "stat", "question", "listicle"];

export function HookBank() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "LinkedIn" }, { label: "Hook bank" }]), [setBreadcrumbs]);
  const [angle, setAngle] = useState("all");
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.liHooks, queryFn: () => linkedinQueueApi.hooks() });

  const hooks = (data ?? []).filter((h) => angle === "all" || h.angle === angle);

  return (
    <div className="space-y-4">
      <AgnbSubnav group="linkedinQueue" />
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Hook bank</h1>
        <div className="flex flex-wrap gap-1">
          {ANGLES.map((a) => (
            <button key={a} onClick={() => setAngle(a)}
              className={cn("rounded-md border px-2 py-0.5 text-xs capitalize", angle === a ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
              {a}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : hooks.length === 0 ? (
        <EmptyState icon={Anchor} message="No hooks." />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {hooks.map((h) => (
            <Card key={h.id}><CardContent className="p-3">
              <div className="flex items-center justify-between"><Badge variant="outline">{h.angle}</Badge><span className="text-[11px] text-muted-foreground">{h.uses} uses</span></div>
              <p className="mt-1 text-sm">{h.hook}</p>
              {h.notes && <p className="mt-1 text-xs text-muted-foreground">{h.notes}</p>}
            </CardContent></Card>
          ))}
        </div>
      )}
    </div>
  );
}
