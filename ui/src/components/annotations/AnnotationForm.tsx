import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AnnotationType, AnnotationSeverity, AnnotationVisibility } from "../../api/annotations";

interface AnnotationFormValues {
  label: string;
  annotationType: AnnotationType;
  severity: AnnotationSeverity;
  visibility: AnnotationVisibility;
}

interface AnnotationFormProps {
  initial?: Partial<AnnotationFormValues>;
  onSubmit: (values: AnnotationFormValues) => void;
  onCancel: () => void;
  submitting?: boolean;
}

export function AnnotationForm({ initial, onSubmit, onCancel, submitting }: AnnotationFormProps) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [annotationType, setAnnotationType] = useState<AnnotationType>(initial?.annotationType ?? "note");
  const [severity, setSeverity] = useState<AnnotationSeverity>(initial?.severity ?? "info");
  const [visibility, setVisibility] = useState<AnnotationVisibility>(initial?.visibility ?? "org_wide");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    onSubmit({ label: label.trim(), annotationType, severity, visibility });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="absolute z-40 right-4 top-1/2 -translate-y-1/2 w-64 rounded-lg border border-border bg-card shadow-lg p-4 flex flex-col gap-3"
    >
      <p className="text-sm font-semibold">New Annotation</p>

      <div className="flex flex-col gap-1">
        <Label htmlFor="ann-label" className="text-xs">Label *</Label>
        <Input
          id="ann-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Describe this annotation"
          className="h-8 text-xs"
          autoFocus
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-xs">Type</Label>
        <div className="flex flex-wrap gap-1">
          {(["perimeter", "hazard", "resource", "note"] as AnnotationType[]).map((t) => (
            <button
              type="button"
              key={t}
              onClick={() => setAnnotationType(t)}
              className={`px-2 py-0.5 rounded text-[11px] border capitalize transition-colors ${annotationType === t ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-xs">Severity</Label>
        <div className="flex gap-1">
          {(["critical", "warning", "info"] as AnnotationSeverity[]).map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => setSeverity(s)}
              className={`px-2 py-0.5 rounded text-[11px] border capitalize transition-colors ${severity === s ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-xs">Visibility</Label>
        <div className="flex gap-1">
          {([["org_wide", "Org-wide"], ["admin_only", "Admin only"]] as [AnnotationVisibility, string][]).map(([v, lbl]) => (
            <button
              type="button"
              key={v}
              onClick={() => setVisibility(v)}
              className={`px-2 py-0.5 rounded text-[11px] border transition-colors ${visibility === v ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {lbl}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" className="flex-1 h-7 text-xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" className="flex-1 h-7 text-xs" disabled={!label.trim() || submitting}>
          Save
        </Button>
      </div>
    </form>
  );
}
