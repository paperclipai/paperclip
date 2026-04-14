import { type ReactNode } from "react";

/**
 * Light-only theme provider.
 * Dark mode is explicitly forbidden per .impeccable.md design spec.
 * This module keeps the provider/hook API so existing consumers don't break,
 * but theme is always "light".
 */

const THEME = "light" as const;

export function ThemeProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useTheme() {
  return { theme: THEME } as const;
}
