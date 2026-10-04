import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  isMacPlatform,
  setSubmitKeyPreference,
  type SubmitKeyMode,
} from "@/lib/submitKeyPreference";

export const SEND_KEY_MENU_HOVER_DELAY_MS = 500;
export const SEND_KEY_MENU_CLOSE_DELAY_MS = 500;

interface SendKeyMenuProps {
  /** The send key currently in effect for this composer (marked in the menu). */
  mode: SubmitKeyMode;
  /** The send button. A plain click on it keeps sending. */
  children: ReactNode;
  /** Skip the menu, e.g. while the button acts as Stop. */
  disabled?: boolean;
  className?: string;
}

/**
 * Wraps a composer's send button. Resting the mouse on it for ~0.5 s, a
 * right-click, or a touch long press (the browser's contextmenu) opens a small menu to choose whether Return or Cmd/Ctrl+Return
 * sends. The choice applies to every composer that reads the preference. Once
 * the mouse has left both the button and the menu for ~0.5 s, the menu closes.
 */
export function SendKeyMenu({
  mode,
  children,
  disabled = false,
  className,
}: SendKeyMenuProps) {
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A touch long press fires contextmenu; the click on finger lift is not a send.
  const swallowClickRef = useRef(false);

  function clearTimer() {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function startTimer(delay: number, onFire?: () => void) {
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onFire?.();
      setOpen(true);
    }, delay);
  }

  function cancelClose() {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }

  function scheduleClose() {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, SEND_KEY_MENU_CLOSE_DELAY_MS);
  }

  useEffect(() => () => {
    clearTimer();
    cancelClose();
  }, []);
  useEffect(() => {
    if (disabled) {
      clearTimer();
      setOpen(false);
    }
  }, [disabled]);

  const mac = isMacPlatform();
  const options: Array<{ value: SubmitKeyMode; label: string; hint: string }> = [
    { value: "enter", label: "Send with Return", hint: "Shift+Return for a new line" },
    {
      value: "mod-enter",
      label: mac ? "Send with ⌘Return" : "Send with Ctrl+Return",
      hint: "Return for a new line",
    },
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span
          data-testid="send-key-menu-anchor"
          className={cn("inline-flex shrink-0", className)}
          onMouseEnter={() => {
            cancelClose();
            if (!disabled && !open) startTimer(SEND_KEY_MENU_HOVER_DELAY_MS);
          }}
          onMouseLeave={() => {
            clearTimer();
            if (open) scheduleClose();
          }}
          onPointerDown={() => {
            swallowClickRef.current = false;
          }}
          onClickCapture={(event) => {
            clearTimer();
            if (swallowClickRef.current) {
              swallowClickRef.current = false;
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onContextMenu={(event) => {
            if (disabled) return;
            event.preventDefault();
            clearTimer();
            swallowClickRef.current = true;
            setOpen(true);
          }}
        >
          {children}
        </span>
      </PopoverAnchor>
      {open ? (
        <PopoverContent
          side="top"
          align="end"
          role="menu"
          aria-label="Send key"
          data-testid="send-key-menu"
          className="w-56 p-1"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {options.map((option) => {
            const active = option.value === mode;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                data-testid={`send-key-menu-${option.value}`}
                className={cn(
                  "flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50",
                  active && "bg-accent",
                )}
                onClick={() => {
                  setSubmitKeyPreference(option.value);
                  cancelClose();
                  setOpen(false);
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium text-foreground">{option.label}</span>
                  <span className="text-(length:--text-micro) text-muted-foreground">{option.hint}</span>
                </span>
                {active ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
              </button>
            );
          })}
        </PopoverContent>
      ) : null}
    </Popover>
  );
}
