import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

interface ThemeContextValue {
  effectiveTheme: Theme;
  theme: Theme;
  themePreference: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  setThemePreference: (theme: ThemePreference) => void;
  toggleTheme: () => void;
}

const THEME_STORAGE_KEY = "paperclip.theme";
const DARK_THEME_COLOR = "#18181b";
const LIGHT_THEME_COLOR = "#ffffff";
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function systemTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "dark";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(stored)) return stored;
  } catch {
    // Ignore local storage read failures in restricted environments.
  }
  return "dark";
}

function resolveThemeFromDocument(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function resolveEffectiveTheme(preference: ThemePreference): Theme {
  return preference === "system" ? systemTheme() : preference;
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
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(() => resolveStoredThemePreference());
  const [effectiveTheme, setEffectiveTheme] = useState<Theme>(() => {
    const preference = resolveStoredThemePreference();
    if (preference === "system") return resolveEffectiveTheme(preference);
    return resolveThemeFromDocument();
  });

  const setThemePreference = useCallback((nextTheme: ThemePreference) => {
    setThemePreferenceState(nextTheme);
  }, []);

  const setTheme = setThemePreference;

  const toggleTheme = useCallback(() => {
    setThemePreferenceState((current) => {
      const currentEffective = resolveEffectiveTheme(current);
      return currentEffective === "dark" ? "light" : "dark";
    });
  }, []);

  useEffect(() => {
    const nextTheme = resolveEffectiveTheme(themePreference);
    setEffectiveTheme(nextTheme);
    applyTheme(nextTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    } catch {
      // Ignore local storage write failures in restricted environments.
    }
  }, [themePreference]);

  useEffect(() => {
    if (themePreference !== "system" || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      const nextTheme = query.matches ? "dark" : "light";
      setEffectiveTheme(nextTheme);
      applyTheme(nextTheme);
    };

    handleChange();
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, [themePreference]);

  const value = useMemo(
    () => ({
      effectiveTheme,
      theme: effectiveTheme,
      themePreference,
      setTheme,
      setThemePreference,
      toggleTheme,
    }),
    [effectiveTheme, themePreference, setTheme, setThemePreference, toggleTheme],
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
