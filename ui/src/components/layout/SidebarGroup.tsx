import { useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import { collapseVariants } from "../../motion/transitions";

interface SidebarGroupProps {
  label: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** Right-side adornment rendered next to the label (e.g. a + button) */
  action?: ReactNode;
  className?: string;
}

function getStoredOpen(key: string, defaultOpen: boolean): boolean {
  try {
    const raw = localStorage.getItem(`paperclip.sidebar.group.${key}`);
    if (raw !== null) return raw === "true";
  } catch {
    // ignore
  }
  return defaultOpen;
}

function persistOpen(key: string, open: boolean) {
  try {
    localStorage.setItem(`paperclip.sidebar.group.${key}`, String(open));
  } catch {
    // ignore
  }
}

export function SidebarGroup({
  label,
  children,
  collapsible = true,
  defaultOpen = true,
  action,
  className,
}: SidebarGroupProps) {
  const storageKey = label.toLowerCase().replace(/\s+/g, "-");
  const [open, setOpen] = useState(() =>
    collapsible ? getStoredOpen(storageKey, defaultOpen) : true
  );

  function toggle() {
    if (!collapsible) return;
    const next = !open;
    setOpen(next);
    persistOpen(storageKey, next);
  }

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Group header */}
      <div className="group flex items-center gap-1 px-3 py-1.5">
        <button
          onClick={toggle}
          disabled={!collapsible}
          className={cn(
            "flex flex-1 min-w-0 items-center gap-1",
            collapsible ? "cursor-pointer" : "cursor-default pointer-events-none",
          )}
          aria-expanded={open}
        >
          {collapsible && (
            <motion.span
              animate={{ rotate: open ? 90 : 0 }}
              transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
              className="inline-flex shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <ChevronRight className="h-3 w-3 text-foreground/40" />
            </motion.span>
          )}
          <span className="text-[10px] font-medium uppercase tracking-wider text-accent/30 truncate">
            {label}
          </span>
        </button>
        {action && (
          <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            {action}
          </span>
        )}
      </div>

      {/* Collapsible content */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="content"
            initial="collapsed"
            animate="expanded"
            exit="collapsed"
            variants={collapseVariants}
          >
            <div className="flex flex-col gap-0.5 pb-1">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
