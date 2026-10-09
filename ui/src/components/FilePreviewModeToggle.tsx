import { Code2, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";

export type FilePreviewMode = "rendered" | "raw";

export function FilePreviewModeToggle({ mode, onChange, label }: {
  mode: FilePreviewMode;
  onChange: (mode: FilePreviewMode) => void;
  label: string;
}) {
  return (
    <div className="flex gap-1" role="group" aria-label={label}>
      <Button type="button" size="icon-sm" variant={mode === "rendered" ? "secondary" : "ghost"} aria-label="Rendered" title="Rendered" aria-pressed={mode === "rendered"} onClick={() => onChange("rendered")}>
        <Eye aria-hidden />
      </Button>
      <Button type="button" size="icon-sm" variant={mode === "raw" ? "secondary" : "ghost"} aria-label="Raw" title="Raw" aria-pressed={mode === "raw"} onClick={() => onChange("raw")}>
        <Code2 aria-hidden />
      </Button>
    </div>
  );
}
