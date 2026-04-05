import { Monitor, Moon, Sun } from "lucide-react";
import { motion } from "framer-motion";
import { useTheme } from "../../context/ThemeContext";

type ThemePreference = "system" | "light" | "dark";

const OPTIONS: { id: ThemePreference; icon: React.ReactNode; label: string }[] = [
  { id: "system", icon: <Monitor className="h-3.5 w-3.5" />, label: "System" },
  { id: "light", icon: <Sun className="h-3.5 w-3.5" />, label: "Light" },
  { id: "dark", icon: <Moon className="h-3.5 w-3.5" />, label: "Dark" },
];

export function ThemeToggle() {
  const { preference, setPreference } = useTheme();

  return (
    <div
      role="group"
      aria-label="Theme preference"
      className="relative flex items-center rounded-md bg-[var(--color-subtle,theme(colors.neutral.100))] p-0.5 dark:bg-[var(--color-subtle,theme(colors.neutral.800))]"
    >
      {OPTIONS.map(({ id, icon, label }) => {
        const isActive = preference === id;
        return (
          <button
            key={id}
            type="button"
            aria-label={label}
            aria-pressed={isActive}
            onClick={() => setPreference(id)}
            className="relative z-10 flex h-7 w-7 items-center justify-center rounded-[5px] text-[var(--color-muted-foreground,theme(colors.neutral.500))] transition-colors duration-150 hover:text-[var(--color-foreground,theme(colors.neutral.900))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring,theme(colors.blue.500))] dark:text-[var(--color-muted-foreground,theme(colors.neutral.400))] dark:hover:text-[var(--color-foreground,theme(colors.neutral.100))]"
          >
            {isActive && (
              <motion.span
                layoutId="theme-toggle-indicator"
                className="absolute inset-0 rounded-[5px] bg-[var(--color-background,white)] shadow-sm dark:bg-[var(--color-background,theme(colors.neutral.700))]"
                transition={{ type: "spring", stiffness: 400, damping: 35 }}
              />
            )}
            <span
              className={
                isActive
                  ? "relative text-[var(--color-foreground,theme(colors.neutral.900))] dark:text-[var(--color-foreground,theme(colors.neutral.100))]"
                  : "relative"
              }
            >
              {icon}
            </span>
          </button>
        );
      })}
    </div>
  );
}
