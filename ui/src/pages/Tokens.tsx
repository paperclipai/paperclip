import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Trash2 } from "lucide-react";
import { miscApi } from "../api/agnbMisc";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbFormModal } from "../components/AgnbFormModal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { relativeTime } from "../lib/utils";

export function Tokens() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Ops" }, { label: "API tokens" }]), [setBreadcrumbs]);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: queryKeys.agnb.tokens, queryFn: () => miscApi.tokens() });
  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.agnb.tokens });
  const del = async (id: string) => { if (confirm("Revoke token?")) { await miscApi.deleteToken(id).catch(() => {}); refresh(); } };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">API tokens</h1>
        <Button size="sm" onClick={() => setOpen(true)}>New token</Button>
      </div>
      {open && (
        <AgnbFormModal
          title="New API token"
          fields={[{ key: "name", label: "Name", required: true }, { key: "scopes", label: "Scopes (comma)", placeholder: "buckets:read, metrics:read" }, { key: "rpm", label: "Requests/min", type: "number" }]}
          onClose={() => setOpen(false)}
          onSubmit={async (v) => { const r = await miscApi.createToken({ name: v.name, scopes: v.scopes ? v.scopes.split(",").map((s) => s.trim()).filter(Boolean) : ["metrics:read"], requests_per_minute: v.rpm ? Number(v.rpm) : undefined }); if (r.token) setPlaintext(r.token); refresh(); }}
        />
      )}
      {plaintext && (
        <div className="rounded-md border border-[#435E35]/40 bg-[#435E35]/10 p-3 text-sm">
          <p className="font-semibold">Token (shown once — copy now):</p>
          <code className="mt-1 block break-all font-mono text-xs">{plaintext}</code>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => setPlaintext(null)}>Dismiss</Button>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={KeyRound} message="No tokens." />
      ) : (
        <div className="flex flex-col gap-2">
          {data.map((t) => (
            <div key={t.id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2.5 text-sm">
              <div>
                <div className="flex items-center gap-2"><span className="font-medium">{t.name}</span>{!t.active && <Badge variant="destructive">revoked</Badge>}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{(t.scopes ?? []).join(", ")} · {t.request_count} reqs{t.last_used_at ? ` · last ${relativeTime(t.last_used_at)}` : ""}</div>
              </div>
              <button onClick={() => del(t.id)}><Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
