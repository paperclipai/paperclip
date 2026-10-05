import { useEffect, useId, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Terminal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { copyTextToClipboard } from "@/lib/clipboard";
import { motionMilliseconds, motionNumber } from "@/lib/onboarding-motion-tokens";
import { cn } from "@/lib/utils";

export interface AgentSetupPromptProps {
  /** The complete text to preview and copy; never truncated on the clipboard. */
  prompt: string;
  title?: string;
  description?: string;
  label?: string;
  variant?: "outline" | "ghost";
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  className?: string;
  /** Carry over the clipboard result when generating a prompt already copied it. */
  initialCopyStatus?: "idle" | "copied" | "failed";
  onCopied?: () => void;
}

const agents = [
  { name: "Codex", src: "/brands/codex-color.svg", className: "" },
  { name: "ChatGPT", src: "/brands/apps/openai.svg", className: "dark:invert" },
  { name: "Claude", src: "/brands/claude-color.svg", className: "" },
];

function AgentLogos({ ref, hidden }: { ref: Ref<HTMLSpanElement>; hidden: boolean }) {
  return (
    <span ref={ref} className="agent-setup-logos" data-hidden={hidden} aria-hidden="true">
      {agents.map((agent) => (
        <span key={agent.name} className="agent-setup-logo-slot">
          <span className="agent-setup-logo">
            <img src={agent.src} alt="" className={cn("size-5", agent.className)} draggable={false} />
          </span>
        </span>
      ))}
    </span>
  );
}

function readLogoPositions(group: HTMLSpanElement | null) {
  return Array.from(group?.querySelectorAll<HTMLElement>(".agent-setup-logo") ?? []).map((logo) => {
    const bounds = logo.getBoundingClientRect();
    const transform = getComputedStyle(logo).transform;
    const matrix = transform && transform !== "none" ? new DOMMatrixReadOnly(transform) : null;
    return {
      // A rotated bounding box is larger than the logo. Anchor its unscaled
      // box at the same center, preserving the current hover angle separately.
      left: bounds.left + (bounds.width - logo.offsetWidth) / 2,
      top: bounds.top + (bounds.height - logo.offsetHeight) / 2,
      width: logo.offsetWidth,
      height: logo.offsetHeight,
      transform: `rotate(${matrix ? Math.atan2(matrix.b, matrix.a) * 180 / Math.PI : 0}deg)`,
    };
  });
}

/** A small handoff to the user's agent, with an inspectable prompt and local copy feedback. */
export function AgentSetupPrompt({
  prompt,
  title = "Agent setup",
  description = "Paste this into your agent to take care of setup.",
  label = "Set up with an agent",
  variant = "outline",
  side = "top",
  align = "start",
  className,
  initialCopyStatus = "idle",
  onCopied,
}: AgentSetupPromptProps) {
  const id = useId();
  const reducedMotion = usePrefersReducedMotion();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">(initialCopyStatus);
  const [flight, setFlight] = useState<{ origins: ReturnType<typeof readLogoPositions>; toPreview: boolean } | null>(null);
  const triggerLogos = useRef<HTMLSpanElement>(null);
  const previewLogos = useRef<HTMLSpanElement>(null);
  const flyingLogos = useRef<HTMLSpanElement>(null);
  const activationOrigins = useRef<ReturnType<typeof readLogoPositions> | null>(null);
  const copyAttempt = useRef(0);
  const hasUserCopyAttempt = useRef(false);
  const copying = useRef(false);
  const copyButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setStatus("idle");
    copying.current = false;
    hasUserCopyAttempt.current = false;
    // A pending clipboard result must not label a changed prompt as copied.
    return () => { copyAttempt.current += 1; };
  }, [prompt]);

  useEffect(() => {
    // A delayed generation-time copy must not replace the user's newer result.
    if (!hasUserCopyAttempt.current) setStatus(initialCopyStatus);
  }, [prompt, initialCopyStatus]);

  useEffect(() => {
    if (status !== "copied") return;
    const hold = motionMilliseconds("--agent-setup-copied-hold");
    if (hold <= 0) return;
    const timeout = window.setTimeout(() => setStatus("idle"), hold);
    return () => window.clearTimeout(timeout);
  }, [status]);

  useLayoutEffect(() => {
    if (!flight) return;
    if (reducedMotion || typeof Element.prototype.animate !== "function") {
      setFlight(null);
      return;
    }
    let frame: number;
    let cancelled = false;
    let animations: Animation[] = [];
    const finish = () => { if (!cancelled) setFlight(null); };
    const start = () => {
      const destination = flight.toPreview ? previewLogos.current : triggerLogos.current;
      // Radix publishes this measurement only after positioning its portal.
      // Until then the full-size flight logos remain at the captured origin.
      if (!destination || (flight.toPreview && !getComputedStyle(destination).getPropertyValue("--radix-popover-content-transform-origin").trim())) {
        frame = requestAnimationFrame(start);
        return;
      }
      const targets = readLogoPositions(destination);
      const logos = flyingLogos.current?.querySelectorAll<HTMLElement>(".agent-setup-logo");
      const easing = getComputedStyle(document.documentElement).getPropertyValue("--motion-ease-out-expo").trim();
      animations = Array.from(logos ?? []).map((logo, index) => logo.animate(
        [flight.origins[index], targets[index]].map(({ left, top, transform }) => ({ left: `${left}px`, top: `${top}px`, transform })),
        { duration: motionMilliseconds("--agent-setup-flight-duration"), easing, fill: "both" },
      ));
      void Promise.all(animations.map((animation) => animation.finished)).then(finish, () => {});
    };
    frame = requestAnimationFrame(start);
    // If the viewport moves mid-flight, settle at its live destination.
    window.addEventListener("resize", finish);
    document.addEventListener("scroll", finish, true);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      animations.forEach((animation) => animation.cancel());
      window.removeEventListener("resize", finish);
      document.removeEventListener("scroll", finish, true);
    };
  }, [flight, reducedMotion]);

  function changeOpen(nextOpen: boolean) {
    const origins = activationOrigins.current ?? readLogoPositions(flyingLogos.current ?? (open ? previewLogos.current : triggerLogos.current));
    activationOrigins.current = null;
    setFlight(!reducedMotion && origins.length === agents.length ? { origins, toPreview: nextOpen } : null);
    setOpen(nextOpen);
  }

  async function copyPrompt() {
    if (copying.current || !prompt.trim()) return;
    hasUserCopyAttempt.current = true;
    copying.current = true;
    const attempt = ++copyAttempt.current;
    setStatus("copying");
    try {
      await copyTextToClipboard(prompt);
      if (attempt === copyAttempt.current) {
        setStatus("copied");
        onCopied?.();
      }
    } catch {
      if (attempt === copyAttempt.current) setStatus("failed");
    } finally {
      if (attempt === copyAttempt.current) copying.current = false;
    }
  }

  return (
    <>
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant={variant}
            aria-label={label}
            data-copied={status === "copied"}
            onClick={(event) => {
              // The trigger remains a copy action while open. Dismiss with
              // Close, Escape, or outside interaction without writing again.
              if (open) event.preventDefault();
              else activationOrigins.current = readLogoPositions(flyingLogos.current ?? triggerLogos.current);
              void copyPrompt();
            }}
            className={cn("agent-setup-trigger h-auto min-h-10 max-w-full gap-3 whitespace-normal text-left", variant === "ghost" && "w-full justify-start", className)}
          >
            {status === "copied" ? <Check className="agent-setup-check size-4" /> : <Terminal className="size-4 text-muted-foreground" />}
            <span className="relative min-w-0">
              <span className={status === "copied" ? "invisible" : undefined}>{label}</span>
              {status === "copied" && <span className="agent-setup-confirmation absolute inset-0 flex items-center">Copied!</span>}
            </span>
            <span className="agent-setup-trigger-logos"><AgentLogos ref={triggerLogos} hidden={open || Boolean(flight)} /></span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side={side}
          align={align}
          collisionPadding={motionNumber("--agent-setup-collision-padding")}
          className="agent-setup-popover flex flex-col gap-4 rounded-xl p-4"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-description`}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            copyButton.current?.focus();
          }}
          onFocusOutside={(event) => {
            // The legacy clipboard fallback briefly focuses a textarea in
            // document.body. Keep the preview open so its result stays visible.
            if (copying.current) event.preventDefault();
          }}
        >
          <div className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h2 id={`${id}-title`} className="text-sm font-semibold">{title}</h2>
              <p id={`${id}-description`} className="text-sm leading-relaxed text-muted-foreground">{description}</p>
            </div>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Close agent setup" onClick={() => changeOpen(false)}>
              <X className="size-3.5" />
            </Button>
          </div>

          <div className="agent-setup-preview-wrap relative pt-2">
            <div className="agent-setup-preview-logos absolute right-3 top-0 z-10"><AgentLogos ref={previewLogos} hidden={Boolean(flight)} /></div>
            {status === "failed" ? (
              <Textarea
                aria-label="Setup prompt"
                readOnly
                value={prompt}
                onFocus={(event) => event.currentTarget.select()}
                className="agent-setup-preview resize-none rounded-lg bg-muted/50 p-3 pt-5 font-mono text-xs leading-relaxed"
              />
            ) : (
              <pre tabIndex={0} aria-label="Setup prompt" className="agent-setup-preview m-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/50 p-3 pt-5 font-mono text-xs leading-relaxed text-muted-foreground">{prompt}</pre>
            )}
          </div>

          <div className="flex flex-col gap-2">
            {status === "failed" && (
              <p role="alert" className="text-xs text-destructive">Could not copy automatically. Select and copy the prompt above, or try again.</p>
            )}
            <Button
              ref={copyButton}
              type="button"
              variant="cta"
              className="agent-setup-copy w-full"
              data-copied={status === "copied"}
              aria-disabled={status === "copying" || !prompt.trim()}
              onClick={() => { if (prompt.trim()) void copyPrompt(); }}
            >
              {status === "copied" ? <Check className="agent-setup-check size-4" /> : <Copy className="size-4" />}
              {status === "copied" ? "Copied to clipboard" : status === "copying" ? "Copying…" : status === "failed" ? "Try copying again" : "Copy prompt"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              {status === "copied" ? "Ready to paste into your agent." : "Works with Codex, ChatGPT, Claude, and more."}
            </p>
          </div>
        </PopoverContent>
      </Popover>
      <span role="status" className="sr-only">{status === "copied" ? "Setup prompt copied. Ready to paste into your agent." : ""}</span>
      {flight && createPortal(
        <span ref={flyingLogos} className="agent-setup-flight-layer" aria-hidden="true">
          {agents.map((agent, index) => (
            <span key={agent.name} className="agent-setup-logo agent-setup-flying-logo" style={flight.origins[index]}>
              <img src={agent.src} alt="" className={cn("size-5", agent.className)} draggable={false} />
            </span>
          ))}
        </span>,
        document.body,
      )}
    </>
  );
}
