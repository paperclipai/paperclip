import { Button } from "@/components/ui/button";
import { Plus, X } from "lucide-react";

// Small, dependency-free key/value + list editors reused across the Brand Kit
// structured forms (NEO-271). Each is fully controlled — the parent owns state
// and re-serializes to DESIGN.md on change.

const inputCls =
  "rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none";

// Ordered list of [key, value] string pairs. Used for rounded / spacing /
// elevation / breakpoints / motion.durations / motion.easings / typography.families.
export function RecordEditor({
  value,
  onChange,
  keyPlaceholder = "token",
  valuePlaceholder = "value",
  addLabel = "Add token",
  numericValue = false,
}: {
  value: Array<[string, string]>;
  onChange: (next: Array<[string, string]>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
  numericValue?: boolean;
}) {
  const setRow = (i: number, key: string, val: string) => {
    const next = value.slice();
    next[i] = [key, val];
    onChange(next);
  };
  return (
    <div className="space-y-1.5">
      {value.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            className={`${inputCls} w-32 font-mono`}
            value={k}
            placeholder={keyPlaceholder}
            onChange={(e) => setRow(i, e.target.value, v)}
          />
          <input
            className={`${inputCls} flex-1`}
            value={v}
            inputMode={numericValue ? "numeric" : undefined}
            placeholder={valuePlaceholder}
            onChange={(e) => setRow(i, k, e.target.value)}
          />
          <button
            type="button"
            aria-label="Remove"
            className="rounded p-1 text-muted-foreground hover:text-destructive"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onChange([...value, ["", ""]])}
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}

// Ordered list of free strings. Used for tone attributes, treatments, samples,
// proof points, lexicon lists.
export function StringListEditor({
  value,
  onChange,
  placeholder = "value",
  addLabel = "Add",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  addLabel?: string;
}) {
  return (
    <div className="space-y-1.5">
      {value.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            className={`${inputCls} flex-1`}
            value={v}
            placeholder={placeholder}
            onChange={(e) => {
              const next = value.slice();
              next[i] = e.target.value;
              onChange(next);
            }}
          />
          <button
            type="button"
            aria-label="Remove"
            className="rounded p-1 text-muted-foreground hover:text-destructive"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onChange([...value, ""])}
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        {addLabel}
      </Button>
    </div>
  );
}

export const brandKitInputCls = inputCls;
