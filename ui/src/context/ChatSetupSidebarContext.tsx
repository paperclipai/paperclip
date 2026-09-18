import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

const ChatSetupSidebarContext = createContext<{
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
} | null>(null);

/** Keeps setup navigation owned by the form while rendering it in the shell. */
export function ChatSetupSidebarProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ target, setTarget }), [target]);
  return <ChatSetupSidebarContext.Provider value={value}>{children}</ChatSetupSidebarContext.Provider>;
}

export function useChatSetupSidebar() {
  return useContext(ChatSetupSidebarContext);
}
