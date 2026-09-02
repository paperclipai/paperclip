// Presentational primitives for the onboarding wizard's agent arc, ported from
// the onboarding prototype onto the repo's design tokens. No backend logic
// lives here — these are pure view pieces.
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** The centered card frame each step of the arc sits in. */
export function OnboardingCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "w-(--sz-560px) max-w-full rounded-xl border border-border bg-card px-8 py-10 sm:px-10 sm:py-11",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Display heading + supporting lede, ported from the prototype's hero type. */
export function OnboardingHeading({
  title,
  lede,
  center,
}: {
  title: ReactNode;
  lede?: ReactNode;
  center?: boolean;
}) {
  return (
    <div className={cn("space-y-2", center && "text-center")}>
      <h1 className="text-4xl font-semibold tracking-tight text-foreground">{title}</h1>
      {lede ? (
        <p className="text-base leading-relaxed text-muted-foreground">{lede}</p>
      ) : null}
    </div>
  );
}
