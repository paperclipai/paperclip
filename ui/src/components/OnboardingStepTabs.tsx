import type { ComponentType, SVGProps } from "react";
import { cn } from "../lib/utils";

export interface OnboardingStepTabItem {
  id: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  disabled?: boolean;
}

interface OnboardingStepTabsProps {
  items: ReadonlyArray<OnboardingStepTabItem>;
  activeId: string;
  onSelect?: (id: string) => void;
  className?: string;
}

export function OnboardingStepTabs({
  items,
  activeId,
  onSelect,
  className,
}: OnboardingStepTabsProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-0 mb-8 border-b border-border",
        className,
      )}
    >
      {items.map(({ id, label, icon: Icon, disabled }) => {
        const isActive = id === activeId;
        return (
          <button
            key={id}
            type="button"
            disabled={disabled}
            onClick={() => {
              if (disabled || isActive) return;
              onSelect?.(id);
            }}
            className={cn(
              "flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
              disabled
                ? "border-transparent text-muted-foreground/40 cursor-not-allowed"
                : isActive
                  ? "border-foreground text-foreground cursor-default"
                  : "border-transparent text-muted-foreground hover:text-foreground/70 hover:border-border cursor-pointer",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
