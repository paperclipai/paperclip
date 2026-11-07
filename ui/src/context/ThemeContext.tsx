import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** The theme actually applied to the document. */
type Theme = "light" | "dark";

/**
 * What the user asked for. `system` means "follow the operating system" and is
 * the state a browser is in before any choice is stored.
 */
export type ThemePreference = Theme | "system";

interface ThemeContextValue {
  /** The theme in effect right now, with `system` already resolved. */
  theme: Theme;
  /** The stored preference, so a control can show which of the three is active. */
  themePreference: ThemePreference;
  setTheme: (preference: ThemePreference) => void;
  toggleTheme: () => void;
}

const THEME_STORAGE_KEY = "paperclip.theme";
const DARK_THEME_COLOR = "#18181b";
const LIGHT_THEME_COLOR = "#ffffff";
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/**
 * Order the single-button control walks through. `system` is a real stop rather
 * than an extra control: the same button reaches all three states, and the
 * label always names the state it moves to.
 */
const TOGGLE_ORDER: readonly ThemePreference[] = ["light", "dark", "system"];

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function resolveThemeFromDocument(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function readSystemTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return resolveThemeFromDocument();
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const isDark = theme === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta instanceof HTMLMetaElement) {
    themeColorMeta.setAttribute("content", isDark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    readStoredPreference(),
  );
  const [systemTheme, setSystemTheme] = useState<Theme>(() => readSystemTheme());

  const theme = themePreference === "system" ? systemTheme : themePreference;

  const setTheme = useCallback((nextPreference: ThemePreference) => {
    // Read the OS now rather than trusting `systemTheme`, which stops tracking
    // the OS while an explicit theme is selected. Both updates land in one
    // render, so the first frame after the switch already shows the right theme.
    if (nextPreference === "system") setSystemTheme(readSystemTheme());
    setThemePreference(nextPreference);
  }, []);

  const toggleTheme = useCallback(() => {
    const index = TOGGLE_ORDER.indexOf(themePreference);
    const nextPreference = TOGGLE_ORDER[(index + 1) % TOGGLE_ORDER.length];
    if (nextPreference === "system") setSystemTheme(readSystemTheme());
    setThemePreference(nextPreference);
  }, [themePreference]);

  useEffect(() => {
    applyTheme(theme);
    try {
      if (themePreference === "system") {
        // Absence of a stored value is what means "follow the OS", so the
        // bootstrap script in index.html agrees with this provider on reload.
        window.localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
      }
    } catch {
      // Ignore local storage write failures in restricted environments.
    }
  }, [theme, themePreference]);

  // Follow OS-level `prefers-color-scheme` changes while the preference is
  // `system`, so the UI flips alongside the OS theme mid-session.
  useEffect(() => {
    if (themePreference !== "system") return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemTheme(media.matches ? "dark" : "light");
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [themePreference]);

  const value = useMemo(
    () => ({
      theme,
      themePreference,
      setTheme,
      toggleTheme,
    }),
    [theme, themePreference, setTheme, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
