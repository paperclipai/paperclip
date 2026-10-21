import { createContext, useContext, type ReactNode } from "react";

export type FlyoutAppearance = "default" | "refreshed";
const FlyoutAppearanceContext = createContext<FlyoutAppearance>("default");

/** Opt existing dropdown and popover primitives into the proposed shared style.
 * React context follows portals, so menus retain their existing behavior. */
export function FlyoutAppearanceProvider({ children, appearance = "refreshed" }: { children: ReactNode; appearance?: FlyoutAppearance }) {
  return <FlyoutAppearanceContext.Provider value={appearance}>{children}</FlyoutAppearanceContext.Provider>;
}

export function useFlyoutAppearance() {
  return useContext(FlyoutAppearanceContext);
}
