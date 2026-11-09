import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

const SetupWizardSidebarContext = createContext<{
  active: boolean;
  setActive: (active: boolean) => void;
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
} | null>(null);

/** Keeps setup navigation owned by the form while rendering it in the shell. */
export function SetupWizardSidebarProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ target, setTarget, active, setActive }), [target, active]);
  return <SetupWizardSidebarContext.Provider value={value}>{children}</SetupWizardSidebarContext.Provider>;
}

export function useSetupWizardSidebar() {
  return useContext(SetupWizardSidebarContext);
}
