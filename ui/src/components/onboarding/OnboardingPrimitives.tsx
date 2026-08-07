// Shared presentational primitives for the onboarding flow. Ported from the
// prototype's hand-written CSS onto the repo's design tokens (semantic colors,
// Tailwind v4). No backend logic lives here — these are pure view pieces.
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConnectorOption } from "./onboarding-data";

/**
 * The centered card frame every onboarding step sits in.
 *
 * `translucent` renders the panel at 95% so an animated backdrop (the orbiting
 * paperclip on the auth + welcome screens) reads through it, per the design.
 */
export function OnboardingCard({
  children,
  className,
  translucent,
}: {
  children: ReactNode;
  className?: string;
  translucent?: boolean;
}) {
  return (
    <div
      className={cn(
        "w-(--sz-560px) max-w-full rounded-xl border border-border px-8 py-10 sm:px-10 sm:py-11",
        translucent ? "bg-card/95" : "bg-card",
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

/** Segmented progress bar with "Step N of M" meta. `total` defaults to 3. */
export function Stepper({ step, total = 3 }: { step: number; total?: number }) {
  return (
    <div className="mb-7 flex flex-col gap-3.5">
      <div className="flex items-center gap-2">
        {Array.from({ length: total }, (_, i) => i + 1).map((s) => (
          <span
            key={s}
            className={cn(
              "h-(--sz-3px) flex-1 rounded-full transition-colors",
              s <= step ? "bg-foreground" : "bg-border",
            )}
          />
        ))}
      </div>
      <span className="text-(length:--text-micro) font-medium uppercase tracking-widest text-muted-foreground">
        Step {step} of {total}
      </span>
    </div>
  );
}

/** Selectable pill chip (mission suggestions). */
export function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3.5 py-2 text-sm transition-colors",
        active
          ? "border-foreground bg-accent text-foreground"
          : "border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/** Large selectable option card (first-task choices). */
export function ChoiceCard({
  icon,
  title,
  description,
  selected,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3.5 rounded-md border bg-muted/30 p-4 text-left transition-all",
        selected
          ? "border-foreground ring-(length:--rad-3) ring-foreground/10"
          : "border-border hover:border-muted-foreground",
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-background text-foreground">
        {icon}
      </span>
      <span className="flex-1">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="mt-1 block text-(length:--text-compact) leading-snug text-muted-foreground">
          {description}
        </span>
      </span>
      <Check
        className={cn(
          "size-5 shrink-0 text-green-500 transition-opacity",
          selected ? "opacity-100" : "opacity-0",
        )}
      />
    </button>
  );
}

/** A single connector row with a colored glyph and connect/connected toggle. */
export function ConnectorRow({
  connector,
  connected,
  onToggle,
}: {
  connector: ConnectorOption;
  connected: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3.5 py-3">
      <span
        className="grid size-(--sz-30px) shrink-0 place-items-center rounded-md text-(length:--text-compact) font-bold text-white"
        style={{
          background: connector.color,
          border: connector.border ? "1px solid var(--border)" : undefined,
        }}
      >
        {connector.glyph}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{connector.name}</span>
        <span className="block text-xs text-muted-foreground">{connector.description}</span>
      </span>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "rounded-full border px-3.5 py-2 text-(length:--text-compact) font-medium transition-colors",
          connected
            ? "cursor-default border-border text-muted-foreground"
            : "border-border text-foreground hover:border-muted-foreground",
        )}
      >
        {connected ? "Connected" : "Connect"}
      </button>
    </div>
  );
}
