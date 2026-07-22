import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface FilterValue {
  key: string;
  label: string;
  value: string;
}

interface FilterBarProps {
  filters: FilterValue[];
  onRemove: (key: string) => void;
  onClear: () => void;
}

export function FilterBar({ filters, onRemove, onClear }: FilterBarProps) {
  if (filters.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {filters.map((f) => (
        <Badge key={f.key} variant="secondary" className="gap-1 pr-1">
          <span className="text-muted-foreground">{f.label}:</span>
          <span>{f.value}</span>
          <button
            className="ml-1 rounded-full hover:bg-accent p-0.5"
            onClick={() => onRemove(f.key)}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <Button variant="ghost" size="sm" className="text-xs h-6" onClick={onClear}>
        Clear all
      </Button>
    </div>
  );
}
