import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Download, Save, ArrowLeft } from "lucide-react";
import { marketingApi } from "../api/marketing";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { extractVars, render, groupVars, type AssetVar } from "../lib/agnbAssetVars";
import { cn, relativeTime } from "../lib/utils";

export function AssetDetail() {
  const { assetId = "" } = useParams<{ assetId: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["agnb", "asset", assetId],
    queryFn: () => marketingApi.get(assetId),
    enabled: !!assetId,
  });

  const asset = data?.asset;
  const LS_KEY = `agnb:asset:${assetId}:draft`;

  const [tab, setTab] = useState<"fill" | "source">("fill");
  const [values, setValues] = useState<Record<string, string>>({});
  const [customer, setCustomer] = useState("");
  const [html, setHtml] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const initialHtml = useRef("");

  useEffect(() => {
    if (asset) setBreadcrumbs([{ label: "Assets", href: "/assets" }, { label: asset.title }]);
  }, [asset, setBreadcrumbs]);

  // Seed html + var defaults when the asset loads.
  useEffect(() => {
    if (!asset) return;
    setHtml(asset.html);
    initialHtml.current = asset.html;
    const vars = extractVars(asset.html);
    setValues((prev) => {
      const next = { ...prev };
      for (const v of vars) if (next[v.name] === undefined) next[v.name] = v.defaultValue;
      return next;
    });
  }, [asset]);

  // Hydrate draft from localStorage once.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d?.values) setValues((p) => ({ ...p, ...d.values }));
      if (d?.customer) setCustomer(d.customer);
    } catch { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  // Debounced autosave.
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(LS_KEY, JSON.stringify({ values, customer })); } catch { /* noop */ }
    }, 400);
    return () => clearTimeout(t);
  }, [values, customer, LS_KEY]);

  const vars = useMemo(() => extractVars(html), [html]);
  const rendered = useMemo(() => render(html, values), [html, values]);
  const groups = useMemo(() => groupVars(vars), [vars]);

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error || !asset) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{(error as Error)?.message ?? "Asset not found"}</p>
        <Link to="/assets" className="text-sm text-muted-foreground hover:text-foreground">← Back to assets</Link>
      </div>
    );
  }

  const downloadHtml = () => {
    const blob = new Blob([rendered], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${asset.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${customer || "fill"}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const saveFill = async () => {
    setSaveBusy(true);
    try {
      await marketingApi.fill({ asset_id: assetId, customer_name: customer || null, variables_used: values, html_rendered: rendered });
      localStorage.removeItem(LS_KEY);
      await refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaveBusy(false);
    }
  };

  const saveTemplate = async () => {
    setSaveBusy(true);
    try {
      await marketingApi.patch(assetId, { html, bumpVersion: true });
      initialHtml.current = html;
      await refetch();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaveBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Link to="/assets" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3 w-3" /> Back to assets
      </Link>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{asset.title}</h1>
          <p className="text-xs text-muted-foreground">{asset.stage} · {asset.kind} · v{asset.version} · {asset.status}</p>
        </div>
        <div className="flex gap-1">
          <button onClick={() => setTab("fill")} className={cn("rounded-md border px-2.5 py-1 text-xs", tab === "fill" ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>Fill + preview</button>
          <button onClick={() => setTab("source")} className={cn("rounded-md border px-2.5 py-1 text-xs", tab === "source" ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground")}>Source HTML</button>
        </div>
      </div>

      {tab === "fill" ? (
        <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
          {/* Variables form */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Variables ({vars.length})</span>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Customer</label>
              <Input value={customer} onChange={(e) => setCustomer(e.target.value)} list="customer-history" placeholder="Customer / account" />
              <datalist id="customer-history">
                {(data?.fills ?? []).map((f) => f.customer_name).filter(Boolean).map((n) => <option key={n!} value={n!} />)}
              </datalist>
            </div>
            {groups.length === 0 && <p className="text-xs text-muted-foreground">No variables in this template.</p>}
            {groups.map((g) => (
              <div key={g.label} className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">{g.label}</div>
                {g.vars.map((v) => <VarInput key={v.name} v={v} value={values[v.name] ?? ""} onChange={(val) => setValues((p) => ({ ...p, [v.name]: val }))} />)}
              </div>
            ))}
          </div>

          {/* Preview */}
          <div className="space-y-2">
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={downloadHtml}><Download className="mr-1 h-3.5 w-3.5" /> HTML</Button>
              <Button size="sm" onClick={saveFill} disabled={saveBusy}><Save className="mr-1 h-3.5 w-3.5" /> Save fill</Button>
            </div>
            <iframe srcDoc={rendered || "<p style='font-family:sans-serif;color:#999;padding:24px'>No template HTML.</p>"} sandbox="allow-same-origin" title="preview" className="h-[640px] w-full rounded-md border border-border bg-white" />
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{html !== initialHtml.current ? "Unsaved changes" : "Saved"}</span>
            <Button size="sm" onClick={saveTemplate} disabled={saveBusy || html === initialHtml.current}>Save template</Button>
          </div>
          <textarea value={html} onChange={(e) => setHtml(e.target.value)} spellCheck={false} className="h-[560px] w-full rounded-md border border-border bg-background p-3 font-mono text-xs" />
        </div>
      )}

      {/* Recent fills */}
      {(data?.fills?.length ?? 0) > 0 && (
        <div>
          <h2 className="mb-1 text-sm font-medium text-muted-foreground">Recent fills</h2>
          <div className="flex flex-col gap-1">
            {data!.fills.map((f) => (
              <div key={f.id} className="flex justify-between rounded-md border border-border px-2.5 py-1.5 text-xs">
                <span>{f.customer_name ?? "(unnamed)"}</span>
                <span className="text-muted-foreground">{f.created_by} · {relativeTime(f.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}

function VarInput({ v, value, onChange }: { v: AssetVar; value: string; onChange: (val: string) => void }) {
  const common = "w-full rounded-md border border-border bg-background px-2 py-1 text-sm";
  return (
    <div>
      <label className="text-xs text-muted-foreground">{v.label}</label>
      {v.type === "textarea" ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} className={common} />
      ) : (
        <input
          type={v.type === "number" ? "number" : v.type === "date" ? "date" : v.type === "image" ? "url" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={common}
        />
      )}
      {v.type === "image" && value && <img src={value} alt="" className="mt-1 max-h-20 rounded border border-border" />}
    </div>
  );
}

