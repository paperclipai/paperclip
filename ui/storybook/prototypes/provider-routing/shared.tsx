import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const reviewPath = (group: string, story: string) =>
  `/?path=/story/ai-connections-provider-routing-${group}--${story}`;

export function AdvancedOptions({
  children,
  label = "Advanced",
  open,
  onOpenChange,
  defaultOpen = false,
}: {
  children: ReactNode;
  label?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
}) {
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      defaultOpen={defaultOpen}
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="group px-0 text-muted-foreground"
        >
          <ChevronDown className="size-4 -rotate-90 group-data-[state=open]:rotate-0" />
          {label}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pt-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
export const reviewGroups = [
  ["00-overview", "start-here", "Start here"],
  ["01-onboarding", "default-path", "Onboarding"],
  ["02-connect", "choose-provider", "Connect"],
  ["03-agent", "codex-new-runner", "Agent"],
  ["04-manage", "connection-list", "Manage"],
  ["05-recovery", "expired-credential", "Recovery"],
  ["06-production-components", "choose-provider", "Production components"],
] as const;

export function ReviewFrame({
  children,
  location,
}: {
  children: ReactNode;
  location: string;
}) {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-4 sm:p-6">
      <aside
        aria-label="Prototype review context"
        className="flex flex-col gap-3 rounded-lg border border-dashed border-border bg-muted p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="text-sm">Provider routing · Design review</strong>
          <span className="text-xs text-muted-foreground">
            Storybook prototype · No live authentication
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          <strong>Location:</strong> {location}
        </p>
        <nav
          aria-label="Provider routing review"
          className="flex flex-wrap gap-x-4 gap-y-2"
        >
          {reviewGroups.map(([group, story, label]) => (
            <a
              key={group}
              className="text-sm underline underline-offset-4"
              href={reviewPath(group, story)}
              target="_top"
            >
              {label}
            </a>
          ))}
        </nav>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            Production location and prototype scope
          </summary>
          <p className="mt-3">
            Uses existing Paperclip components with local fixture state.
            Provider support, accounts, model catalogs, and tests are
            illustrative fixtures; these flows are not wired to the product.
          </p>
        </details>
      </aside>
      <div
        className="min-w-0 rounded-lg border border-border bg-background"
        data-testid="provider-routing-preview"
      >
        {children}
      </div>
    </div>
  );
}
export function Surface({
  title,
  description,
  children,
  embedded = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  embedded?: boolean;
}) {
  return (
    <section
      className={
        embedded
          ? "flex flex-col gap-6"
          : "mx-auto flex max-w-2xl flex-col gap-6 p-4 sm:p-6"
      }
    >
      {!embedded && (
        <header className="space-y-2">
          <h1 className="text-xl font-semibold">{title}</h1>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </header>
      )}
      {children}
    </section>
  );
}
export function TextField({
  label,
  hint,
  ...props
}: { label: string; hint?: string } & React.ComponentProps<typeof Input>) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...props}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
export function Choice({
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
export function Footer({
  back,
  next,
  onBack,
  onNext,
  disabled,
}: {
  back?: string;
  next: string;
  onBack: () => void;
  onNext: () => void;
  disabled?: boolean;
}) {
  return (
    <footer className="flex items-center justify-between gap-3 border-t border-border pt-4">
      <Button variant="ghost" onClick={onBack}>
        {back ?? "Back"}
      </Button>
      <Button onClick={onNext} disabled={disabled}>
        {next}
      </Button>
    </footer>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      className={`rounded-md border p-3 text-sm ${error ? "border-destructive/30 text-destructive" : "border-border bg-muted text-foreground"}`}
    >
      {children}
    </div>
  );
}
