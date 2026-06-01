import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface FormField {
  key: string;
  label: string;
  type?: "text" | "textarea" | "number" | "select";
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  required?: boolean;
}

/** Generic create/edit modal: renders fields, collects values, calls onSubmit. */
export function AgnbFormModal({
  title,
  fields,
  submitLabel = "Save",
  initial = {},
  onClose,
  onSubmit,
}: {
  title: string;
  fields: FormField[];
  submitLabel?: string;
  initial?: Record<string, string>;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => Promise<void>;
}) {
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of fields) v[f.key] = initial[f.key] ?? "";
    return v;
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string, val: string) => setVals((p) => ({ ...p, [k]: val }));
  const field = "w-full rounded-md border border-border bg-background px-2 py-1 text-sm";

  const submit = async () => {
    for (const f of fields) if (f.required && !vals[f.key]?.trim()) { setErr(`${f.label} required`); return; }
    setBusy(true); setErr(null);
    try { await onSubmit(vals); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Failed"); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">{title}</h3><button onClick={onClose}><X className="h-4 w-4 text-muted-foreground" /></button></div>
        <div className="space-y-2">
          {fields.map((f) => (
            <div key={f.key}>
              <label className="text-xs text-muted-foreground">{f.label}{f.required ? " *" : ""}</label>
              {f.type === "textarea" ? (
                <textarea value={vals[f.key]} onChange={(e) => set(f.key, e.target.value)} rows={3} placeholder={f.placeholder} className={field} />
              ) : f.type === "select" ? (
                <select value={vals[f.key]} onChange={(e) => set(f.key, e.target.value)} className={field}>
                  {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <Input type={f.type === "number" ? "number" : "text"} value={vals[f.key]} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} />
              )}
            </div>
          ))}
          {err && <p className="text-xs text-destructive">{err}</p>}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={busy}>{busy ? "Saving…" : submitLabel}</Button>
        </div>
      </div>
    </div>
  );
}
