import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Anchor, Trash2 } from "lucide-react";
import { linkedinQueueApi } from "../api/agnbLinkedinQueue";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

const ANGLES = ["all", "contrarian", "personal", "stat", "question", "listicle"];
const ANGLE_OPTS = ["contrarian", "personal", "stat", "question", "listicle"];

export function HookBank() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Content" }, { label: "Hook bank" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [angle, setAngle] = useState("all");
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.liHooks, queryFn: () => linkedinQueueApi.hooks() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.liHooks });
  const del = async (id: string) => { await linkedinQueueApi.deleteHook(id).catch(() => {}); refresh(); };

  const hooks = (data ?? []).filter((h) => angle === "all" || h.angle === angle);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Hook bank</h1>
        <div className="flex flex-wrap items-center gap-1">
          {ANGLES.map((a) => (
            <button key={a} onClick={() => setAngle(a)}
              className={cn("rounded-md border px-2 py-0.5 text-xs capitalize", angle === a ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>
              {a}
            </button>
          ))}
          <Button size="sm" className="ml-1" onClick={() => setOpen(true)}>Add hook</Button>
        </div>
      </div>
      <AgnbSubnav group="content" />
      {open && (
        <AgnbFormModal
          title="Add hook"
          fields={[{ key: "hook", label: "Hook", required: true, type: "textarea" }, { key: "angle", label: "Angle", type: "select", options: ANGLE_OPTS.map((a) => ({ value: a, label: a })) }, { key: "notes", label: "Notes" }]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { await linkedinQueueApi.addHook({ hook: v.hook, angle: v.angle || "contrarian", notes: v.notes || undefined }); refresh(); }}
        />
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : hooks.length === 0 ? (
        <EmptyState icon={Anchor} message="No hooks." />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {hooks.map((h) => (
            <Card key={h.id}><CardContent className="p-3">
              <div className="flex items-center justify-between"><Badge variant="outline">{h.angle}</Badge><span className="flex items-center gap-2 text-[11px] text-muted-foreground">{h.uses} uses<button onClick={() => del(h.id)}><Trash2 className="h-3 w-3 hover:text-destructive" /></button></span></div>
              <p className="mt-1 text-sm">{h.hook}</p>
              {h.notes && <p className="mt-1 text-xs text-muted-foreground">{h.notes}</p>}
            </CardContent></Card>
          ))}
        </div>
      )}
    </div>
  );
}
