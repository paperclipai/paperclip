import { useId, type ReactNode } from "react";
import { Search } from "lucide-react";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { TruncatedText } from "./TruncatedText";

export function FilterGroup({ title, searchLabel, query, onQueryChange, children, optionsKey }: { title: string; searchLabel?: string; query?: string; onQueryChange?: (value: string) => void; children: ReactNode; optionsKey: string }) {
  const headingId = useId();
  return (
    <section className="task-filter-group" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      <div className="task-filter-group-body">
        {searchLabel ? <div className="task-filter-search"><Search aria-hidden /><Input aria-label={`Search ${searchLabel}`} placeholder={`Search ${searchLabel}...`} value={query} onChange={event => onQueryChange?.(event.target.value)} /></div> : null}
        <div className="task-filter-options" data-filter-options={optionsKey}>{children}</div>
      </div>
    </section>
  );
}

export function FilterRow({ label, checked, onToggle, icon }: { label: string; checked: boolean; onToggle: () => void; icon?: ReactNode }) {
  return <label className="task-filter-option" data-marquee-surface><Checkbox aria-label={label} checked={checked} onCheckedChange={onToggle} />{icon ? <span className="task-filter-icon" aria-hidden>{icon}</span> : null}<TruncatedText className="task-filter-option-label">{label}</TruncatedText></label>;
}
