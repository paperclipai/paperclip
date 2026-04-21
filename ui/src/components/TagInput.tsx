import { useCallback, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { X, GripVertical } from "lucide-react";

// ---------------------------------------------------------------------------
// TagInput — reusable tag input with Enter-to-add, drag-to-reorder, and
// optional dropdown suggestions.
// ---------------------------------------------------------------------------

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
  className?: string;
  disabled?: boolean;
}

export function TagInput({
  value,
  onChange,
  placeholder = "Type and press Enter…",
  suggestions = [],
  className,
  disabled,
}: TagInputProps) {
  const [inputValue, setInputValue] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Filter suggestions: exclude already-added tags and match input
  const filtered = suggestions.filter(
    (s) =>
      !value.includes(s) &&
      s.toLowerCase().includes(inputValue.toLowerCase()),
  );

  const addTag = useCallback(
    (raw: string) => {
      const tag = raw.trim();
      if (!tag || value.includes(tag)) return;
      onChange([...value, tag]);
      setInputValue("");
      setShowSuggestions(false);
    },
    [value, onChange],
  );

  const removeTag = useCallback(
    (idx: number) => {
      onChange(value.filter((_, i) => i !== idx));
    },
    [value, onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(inputValue);
    } else if (e.key === "Backspace" && !inputValue && value.length > 0) {
      removeTag(value.length - 1);
    }
  };

  // --- Drag-and-drop reorder ---
  const handleDragStart = (idx: number) => {
    setDragIdx(idx);
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDragOverIdx(idx);
  };

  const handleDrop = (idx: number) => {
    if (dragIdx === null || dragIdx === idx) {
      setDragIdx(null);
      setDragOverIdx(null);
      return;
    }
    const next = [...value];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(idx, 0, moved);
    onChange(next);
    setDragIdx(null);
    setDragOverIdx(null);
  };

  const handleDragEnd = () => {
    setDragIdx(null);
    setDragOverIdx(null);
  };

  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "flex flex-wrap items-center gap-1.5 min-h-[36px] w-full border border-border bg-transparent px-2 py-1.5 transition-colors",
          "focus-within:border-foreground/40",
          disabled && "opacity-50 pointer-events-none",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((tag, i) => (
          <span
            key={`${tag}-${i}`}
            draggable
            onDragStart={() => handleDragStart(i)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDrop={() => handleDrop(i)}
            onDragEnd={handleDragEnd}
            className={cn(
              "inline-flex items-center gap-0.5 border px-1.5 py-0.5 text-xs select-none cursor-grab active:cursor-grabbing transition-all",
              "bg-accent/60 border-border text-foreground",
              dragIdx === i && "opacity-40",
              dragOverIdx === i && dragIdx !== i && "border-foreground/60",
            )}
          >
            <GripVertical className="h-2.5 w-2.5 text-muted-foreground/50 shrink-0" />
            <span className="font-mono text-[11px] leading-none">{tag}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeTag(i);
              }}
              className="ml-0.5 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            setShowSuggestions(true);
          }}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => {
            // Delay to allow click on suggestion
            setTimeout(() => setShowSuggestions(false), 150);
          }}
          placeholder={value.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[120px] bg-transparent outline-none text-sm placeholder:text-muted-foreground/40"
          disabled={disabled}
        />
      </div>

      {/* Suggestions dropdown */}
      {showSuggestions && filtered.length > 0 && inputValue.length > 0 && (
        <div className="absolute z-50 mt-1 max-h-40 w-full overflow-y-auto border border-border bg-popover shadow-md">
          {filtered.slice(0, 12).map((s) => (
            <button
              key={s}
              type="button"
              className="flex w-full items-center px-2.5 py-1.5 text-xs font-mono text-left hover:bg-accent/50 transition-colors"
              onMouseDown={(e) => {
                e.preventDefault();
                addTag(s);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
