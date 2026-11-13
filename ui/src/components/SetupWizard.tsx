import { useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { createPortal } from "react-dom";
import { useSetupWizardSidebar } from "@/context/SetupWizardSidebarContext";
import { useSidebar } from "@/context/SidebarContext";
import { cn } from "@/lib/utils";

export function SetupWizardSidebar() {
  const sidebar = useSetupWizardSidebar();
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-background">
      <div ref={sidebar?.setTarget} className="overflow-y-auto px-4 py-6" />
    </aside>
  );
}

export function SetupWizardNavigation({
  labels,
  ariaLabel = "Setup progress",
  takeover = false,
  inline = false,
  step,
  availableStep,
  disabled = false,
  onSelect,
}: {
  labels: string[];
  ariaLabel?: string;
  takeover?: boolean;
  inline?: boolean;
  step: number;
  availableStep: number;
  disabled?: boolean;
  onSelect: (step: number) => void;
}) {
  const sidebar = useSetupWizardSidebar();
  const { isMobile, setSidebarOpen } = useSidebar();
  const setActive = sidebar?.setActive;
  useEffect(() => {
    if (!takeover || !setActive) return;
    setActive(true);
    return () => setActive(false);
  }, [takeover, setActive]);
  const navigation = (
    <nav aria-label={ariaLabel}>
      <ol className="text-sm">
        {labels.map((label, index) => (
          <li key={label}>
            {index > 0 && (
              <div aria-hidden="true" className="flex w-8 justify-center py-1">
                <span className="h-4 border-l border-border" />
              </div>
            )}
            <button
              type="button"
              aria-current={index === step ? "step" : undefined}
              disabled={disabled || index > availableStep}
              onClick={() => {
                onSelect(index);
                if (isMobile) setSidebarOpen(false);
              }}
              className="flex w-full items-center gap-3 rounded-md text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
            >
              <span className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full border font-medium",
                index === step ? "border-primary bg-primary text-primary-foreground" :
                  index <= availableStep ? "border-foreground text-foreground" : "border-border text-muted-foreground",
              )}>
                {index + 1}
              </span>
              <span className={index === step ? "font-medium text-foreground" : "text-muted-foreground"}>
                {label}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
  // Standalone renders (including component previews) retain usable navigation.
  if (!sidebar || inline) return navigation;
  return sidebar.target ? createPortal(navigation, sidebar.target) : navigation;
}

/** Lets a form temporarily replace the section menu, without replacing global navigation. */
export function SetupWizardSidebarOutlet({ children }: { children: ReactNode }) {
  const sidebar = useSetupWizardSidebar();
  return sidebar?.active ? <SetupWizardSidebar /> : children;
}

/** Each step owns one footer row; secondary actions stay with the primary action. */
export function SetupWizardFooter({ onSaveExit, children, disabled = false }: { onSaveExit: () => void; children: ReactNode; disabled?: boolean }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
    <Button type="button" variant="ghost" className="text-muted-foreground" onClick={onSaveExit} disabled={disabled}>Save &amp; exit</Button>
    <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
  </div>;
}
