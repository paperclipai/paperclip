import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FlyoutAppearanceProvider } from "@/components/ui/flyout";
import { AvatarInitialProvider } from "@/components/ui/avatar-initials";

const storageKey = "paperclip.design-proposals.sandbox";
const DesignSandboxContext = createContext(false);

export function useDesignSandbox() { return useContext(DesignSandboxContext); }

/** Local integration experiment. Neither production builds nor ordinary dev
 * instances enable this through browser storage alone. */
export function DesignSandboxProvider({ children }: { children: ReactNode }) {
  const available = import.meta.env.DEV && import.meta.env.VITE_PAPERCLIP_DESIGN_SANDBOX === "true";
  const [selected, setSelected] = useState(() => {
    try { return localStorage.getItem(storageKey) !== "off"; } catch { return true; }
  });
  const enabled = available && selected;
  useLayoutEffect(() => {
    if (!enabled) return;
    // Use the exact Storybook proposal marker, including its document-wide
    // token propagation to portals. Broad propagation is intentional here.
    const hadMarker = document.body.classList.contains("design-proposal-theme");
    document.body.classList.add("design-proposal-theme");
    return () => { if (!hadMarker) document.body.classList.remove("design-proposal-theme"); };
  }, [enabled]);

  return <DesignSandboxContext.Provider value={enabled}>
    <FlyoutAppearanceProvider appearance={enabled ? "refreshed" : "default"}>
      <AvatarInitialProvider singleInitial={enabled}>{children}</AvatarInitialProvider>
      {available ? <div className="fixed bottom-3 right-3 z-(--z-200) rounded-md border border-border bg-background p-1 shadow-md">
        <Button size="sm" variant={enabled ? "secondary" : "outline"} aria-pressed={enabled} onClick={() => {
          const next = !selected;
          setSelected(next);
          try { localStorage.setItem(storageKey, next ? "on" : "off"); } catch { /* Session-only when storage is unavailable. */ }
        }}>Design proposals: {enabled ? "On" : "Off"}</Button>
      </div> : null}
    </FlyoutAppearanceProvider>
  </DesignSandboxContext.Provider>;
}
