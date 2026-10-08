import type { Ref } from "react";
import { AppLogo } from "@/pages/apps/AppLogo";
import { UnverifiedServerBadge } from "@/pages/apps/UnverifiedServerBadge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function StepHeader({
  title,
  headingRef,
  subtitle,
  step,
  activeIndex,
  labels,
  appIdentity,
  unverifiedHost,
  onCancel,
}: {
  title?: string;
  headingRef?: Ref<HTMLHeadingElement>;
  subtitle?: string;
  step: string;
  activeIndex: number;
  labels: string[];
  appIdentity?: { name: string; logoUrl: string | null; darkLogoUrl?: string | null };
  /**
   * Host of an unknown remote MCP server. Present for the whole generic flow so
   * the operator can see whose server they are configuring at every step, not
   * just on the screen where they pasted the address.
   */
  unverifiedHost?: string | null;
  onCancel?: () => void;
}) {
  return (
    <div className="mb-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          {appIdentity ? (
            <AppLogo name={appIdentity.name} logoUrl={appIdentity.logoUrl} darkLogoUrl={appIdentity.darkLogoUrl} size={44} />
          ) : null}
          <div>
            <h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="text-2xl font-bold tracking-tight outline-none">
              {title ?? (appIdentity ? `Connect ${appIdentity.name}` : "Connect your own MCP server")}
            </h1>
            {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
            {unverifiedHost ? <UnverifiedServerBadge host={unverifiedHost} className="mt-2" /> : null}
          </div>
        </div>
        {onCancel && <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>}
      </div>
      {step !== "gallery" && labels.length > 1 && (
        // A landmark with stable hooks, so the step model can be read without
        // guessing at Tailwind classes. The dots are decoration — the label
        // line below already says the same thing, so announcing both would
        // read every step name twice.
        <nav className="mt-4" aria-label="Setup progress" data-testid="wizard-stepper">
          <ol className="flex gap-2" aria-hidden="true">
            {labels.map((label, i) => (
              <li
                key={label}
                data-testid="wizard-step-dot"
                data-step-active={i === activeIndex ? "true" : undefined}
                className={cn("h-1 w-20 rounded-full", i <= activeIndex ? "bg-foreground" : "bg-border")}
              />
            ))}
          </ol>
          <div className="mt-2 text-xs text-muted-foreground" data-testid="wizard-step-labels">
            {labels.join("   ·   ")}
          </div>
        </nav>
      )}
    </div>
  );
}

