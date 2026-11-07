import { createContext, useContext, type ReactNode } from "react";

const SingleInitialContext = createContext(false);

/** Proposed fallback policy; shared avatars keep their existing default until
 * a surface explicitly adopts the single-initial design. */
export function AvatarInitialProvider({ children, singleInitial = true }: { children: ReactNode; singleInitial?: boolean }) {
  return <SingleInitialContext.Provider value={singleInitial}>{children}</SingleInitialContext.Provider>;
}

export function useAvatarInitials(initials: string) {
  const singleInitial = useContext(SingleInitialContext);
  return singleInitial ? Array.from(initials.trim().toLocaleUpperCase())[0] ?? "" : initials;
}
