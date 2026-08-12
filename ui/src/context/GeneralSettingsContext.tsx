import type { ReactNode } from "react";
import { createContext, useContext } from "react";

export interface GeneralSettingsContextValue {
  keyboardShortcutsEnabled: boolean;
}

const GeneralSettingsContext = createContext<GeneralSettingsContextValue>({
  keyboardShortcutsEnabled: false,
});

export function GeneralSettingsProvider({
  value,
  children,
}: {
  value: GeneralSettingsContextValue;
  children: ReactNode;
}) {
  return (
    <GeneralSettingsContext.Provider value={value}>
      {children}
    </GeneralSettingsContext.Provider>
  );
}

export function useGeneralSettings() {
  return useContext(GeneralSettingsContext);
}
