import { useEffect, useState } from "react";
import { useNavigate, Link } from "@/lib/router";
import { ArrowLeft } from "lucide-react";
import { marketingApi } from "../api/marketing";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const STAGES = ["awareness", "interest", "evaluation", "decision", "onboard", "retention"];

export function NewAsset() {
  const nav = useNavigate();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Assets", href: "/assets" }, { label: "New" }]), [setBreadcrumbs]);

  const [title, setTitle] = useState("");
  const [stage, setStage] = useState("awareness");
  const [kind, setKind] = useState("one_pager");
  const [html, setHtml] = useState("<div class=\"body\">Hi {{customer_name}},</div>");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim()) { setErr("Title required"); return; }
    setBusy(true); setErr(null);
    try {
      const id = await marketingApi.create({ title: title.trim(), stage, kind: kind.trim(), html, notes: notes || null });
      nav(`/assets/${id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
      setBusy(false);
    }
  };

  const field = "w-full rounded-md border border-border bg-background px-2 py-1 text-sm";

  return (
    <div className="space-y-4">
      <Link to="/assets" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3 w-3" /> Back to assets
      </Link>
      <h1 className="text-lg font-semibold">New asset</h1>
      <div className="grid max-w-2xl gap-3">
        <div>
          <label className="text-xs text-muted-foreground">Title</label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Healthcare pitch v1" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Stage</label>
            <select value={stage} onChange={(e) => setStage(e.target.value)} className={field}>
              {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Kind</label>
            <Input value={kind} onChange={(e) => setKind(e.target.value)} placeholder="one_pager" />
          </div>
        </div>
        <div>
          <label className="text-xs text-muted-foreground">HTML template (use {`{{variables}}`})</label>
          <textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={10} spellCheck={false} className={`${field} font-mono`} />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Notes (optional)</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={field} />
        </div>
        {err && <p className="text-xs text-destructive">{err}</p>}
        <div>
          <Button onClick={submit} disabled={busy}>{busy ? "Creating…" : "Create asset"}</Button>
        </div>
      </div>
    </div>
  );
}
