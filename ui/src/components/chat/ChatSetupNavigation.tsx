import { createPortal } from "react-dom";
import { useChatSetupSidebar } from "@/context/ChatSetupSidebarContext";
import { useSidebar } from "@/context/SidebarContext";
import { cn } from "@/lib/utils";

export function ChatSetupSidebar() {
  const sidebar = useChatSetupSidebar();
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-background">
      <div ref={sidebar?.setTarget} className="overflow-y-auto px-4 py-6" />
    </aside>
  );
}

export function ChatSetupNavigation({
  labels = ["Choose agent", "Connect provider", "Try it"],
  step,
  availableStep,
  disabled = false,
  onSelect,
}: {
  labels?: string[];
  step: number;
  availableStep: number;
  disabled?: boolean;
  onSelect: (step: number) => void;
}) {
  const sidebar = useChatSetupSidebar();
  const { isMobile, setSidebarOpen } = useSidebar();
  const navigation = (
    <nav aria-label="Connection setup progress">
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
  if (!sidebar) return navigation;
  return sidebar.target ? createPortal(navigation, sidebar.target) : null;
}
