import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type ThemePreference = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  /** The user's preference: system, light, or dark */
  preference: ThemePreference;
  /** The actually applied theme after resolving system preference */
  theme: ResolvedTheme;
  setPreference: (pref: ThemePreference) => void;
  /** Cycle through: system → light → dark → system */
  cycleTheme: () => void;
}

const THEME_STORAGE_KEY = "paperclip.theme";
const DARK_THEME_COLOR = "#1a1a20";
const LIGHT_THEME_COLOR = "#f9f9fb";
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const CYCLE_ORDER: ThemePreference[] = ["system", "light", "dark"];

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") return getSystemTheme();
  return pref;
}

function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const isDark = resolved === "dark";

  // HeroUI theme data attribute
  root.setAttribute("data-theme", isDark ? "paperclip-dark" : "paperclip");

  // Class-based dark mode (for Tailwind dark: variant)
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";

  // Update meta theme-color for mobile browsers
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta instanceof HTMLMetaElement) {
    meta.setAttribute("content", isDark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
  }
}

function loadPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Restricted environment
  }
  return "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(loadPreference);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme);

  // Listen for OS theme changes
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? "dark" : "light");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const resolved: ResolvedTheme =
    preference === "system" ? systemTheme : preference;

  // Apply theme to DOM whenever it changes
  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  // Persist preference
  useEffect(() => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Ignore
    }
  }, [preference]);

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref);
  }, []);

  const cycleTheme = useCallback(() => {
    setPreferenceState((current) => {
      const idx = CYCLE_ORDER.indexOf(current);
      return CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
    });
  }, []);

  const value = useMemo(
    () => ({
      preference,
      theme: resolved,
      setPreference,
      cycleTheme,
    }),
    [preference, resolved, setPreference, cycleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
