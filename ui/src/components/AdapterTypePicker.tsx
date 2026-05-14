import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";
import { listUIAdapters } from "../adapters";
import { isVisualAdapterChoice } from "../adapters/metadata";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";

interface AdapterTypePickerProps {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  className?: string;
}

const SYSTEM_ADAPTER_TYPES = new Set(["process", "http"]);

export function AdapterTypePicker({
  value,
  onChange,
  disabled,
  className,
}: AdapterTypePickerProps) {
  const disabledTypes = useDisabledAdaptersSync();
  const [showMore, setShowMore] = useState(false);

  const { recommended, more } = useMemo(() => {
    const all = listUIAdapters()
      .filter(
        (a) =>
          !SYSTEM_ADAPTER_TYPES.has(a.type)
          && !disabledTypes.has(a.type)
          && isVisualAdapterChoice(a.type),
      )
      .map((a) => ({ ...getAdapterDisplay(a.type), type: a.type }));

    return {
      recommended: all.filter((a) => a.recommended),
      more: all.filter((a) => !a.recommended),
    };
  }, [disabledTypes]);

  return (
    <div className={className}>
      <div className="grid grid-cols-2 gap-2">
        {recommended.map((opt) => (
          <button
            key={opt.type}
            type="button"
            disabled={disabled}
            className={cn(
              "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
              value === opt.type
                ? "border-foreground bg-accent"
                : "border-border hover:bg-accent/50",
              disabled && "opacity-60 cursor-not-allowed",
            )}
            onClick={() => onChange(opt.type)}
          >
            {opt.recommended ? (
              <span className="absolute -top-1.5 right-1.5 bg-green-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                Recommended
              </span>
            ) : null}
            <opt.icon className="h-4 w-4" />
            <span className="font-medium">{opt.label}</span>
            <span className="text-muted-foreground text-[10px]">
              {opt.description}
            </span>
          </button>
        ))}
      </div>

      {more.length > 0 ? (
        <>
          <button
            type="button"
            className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowMore((v) => !v)}
            disabled={disabled}
          >
            <ChevronDown
              className={cn(
                "h-3 w-3 transition-transform",
                showMore ? "rotate-0" : "-rotate-90",
              )}
            />
            More Agent Adapter Types
          </button>

          {showMore ? (
            <div className="grid grid-cols-2 gap-2 mt-2">
              {more.map((opt) => (
                <button
                  key={opt.type}
                  type="button"
                  disabled={disabled || Boolean(opt.comingSoon)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors relative",
                    opt.comingSoon
                      ? "border-border opacity-40 cursor-not-allowed"
                      : value === opt.type
                        ? "border-foreground bg-accent"
                        : "border-border hover:bg-accent/50",
                  )}
                  onClick={() => {
                    if (opt.comingSoon) return;
                    onChange(opt.type);
                  }}
                >
                  <opt.icon className="h-4 w-4" />
                  <span className="font-medium">{opt.label}</span>
                  <span className="text-muted-foreground text-[10px]">
                    {opt.comingSoon
                      ? (opt.disabledLabel ?? "Coming soon")
                      : opt.description}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
