import { useState } from "react";
import { Tag, X } from "lucide-react";

export function TagsInput({
  value,
  onChange,
  placeholder = "Add tags (Enter or comma)…",
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");

  function commit(raw: string) {
    const next = raw.split(",").map((t) => t.trim()).filter(Boolean);
    if (next.length) onChange([...new Set([...value, ...next])]);
    setInput("");
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap min-h-[36px]">
      <Tag className="h-3 w-3 text-muted-foreground shrink-0" />
      {value.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded bg-accent/70 px-1.5 py-0.5 text-[11px]">
          {tag}
          <button type="button" onClick={() => onChange(value.filter((t) => t !== tag))}>
            <X className="h-2.5 w-2.5 text-muted-foreground hover:text-foreground" />
          </button>
        </span>
      ))}
      <input
        className="flex-1 min-w-[120px] bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
        placeholder={placeholder}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit(input);
          } else if (e.key === "Backspace" && !input && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => { if (input) commit(input); }}
      />
    </div>
  );
}
