import { useState, useMemo } from "react";
import type { CompanySkillListItem } from "@paperclipai/shared";
import { Checkbox } from "@/components/ui/checkbox";
import { Boxes, ChevronDown, Search, X } from "lucide-react";
import { cn } from "../lib/utils";

export function SkillsMultiSelect({
  skills,
  selected,
  onChange,
}: {
  skills: CompanySkillListItem[];
  selected: string[];
  onChange: (keys: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return skills;
    const q = search.toLowerCase();
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description?.toLowerCase().includes(q) ?? false) ||
        s.key.toLowerCase().includes(q),
    );
  }, [skills, search]);

  const selectedNames = useMemo(
    () => skills.filter((s) => selected.includes(s.key)).map((s) => s.name),
    [skills, selected],
  );

  return (
    <div className="rounded-md border border-input bg-background overflow-hidden">
      {/* Trigger header */}
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-accent/50 transition-colors"
        onClick={() => { setOpen((v) => !v); setSearch(""); }}
      >
        <span className="flex items-center gap-2 min-w-0">
          <Boxes className="size-3.5 text-muted-foreground shrink-0" />
          {selected.length === 0 ? (
            <span className="text-muted-foreground">No skills selected</span>
          ) : selected.length <= 2 ? (
            <span className="truncate">{selectedNames.join(", ")}</span>
          ) : (
            <span>{selected.length} skills selected</span>
          )}
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground shrink-0 ml-2 transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <>
          {/* Search + bulk actions */}
          <div className="border-t border-border px-2 py-1.5 flex items-center gap-2 bg-muted/20">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none" />
              <input
                className="w-full pl-6 pr-6 py-1 text-xs bg-background border border-border rounded outline-none placeholder:text-muted-foreground/50 focus:border-ring transition-colors"
                placeholder="Filter skills…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
              {search && (
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setSearch("")}
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
              onClick={() => onChange(skills.map((s) => s.key))}
            >
              All
            </button>
            <span className="text-muted-foreground/40 text-xs">·</span>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
              onClick={() => onChange([])}
            >
              Clear
            </button>
          </div>

          {/* Skill list */}
          <div className="border-t border-border max-h-52 overflow-y-auto divide-y divide-border/40">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-xs text-center text-muted-foreground">
                No skills match &ldquo;{search}&rdquo;
              </div>
            ) : (
              filtered.map((skill) => {
                const checked = selected.includes(skill.key);
                return (
                  <button
                    key={skill.id}
                    type="button"
                    className="flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
                    onClick={() =>
                      onChange(
                        checked
                          ? selected.filter((k) => k !== skill.key)
                          : [...selected, skill.key],
                      )
                    }
                  >
                    <Checkbox
                      checked={checked}
                      className="mt-0.5 shrink-0 pointer-events-none"
                    />
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium leading-none block">{skill.name}</span>
                      {skill.description && (
                        <span className="text-xs text-muted-foreground mt-0.5 line-clamp-2 block">
                          {skill.description}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-border px-3 py-1.5 bg-muted/20 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {selected.length} of {skills.length} selected
            </span>
            {filtered.length !== skills.length && (
              <span className="text-xs text-muted-foreground">
                showing {filtered.length}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
