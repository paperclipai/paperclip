/**
 * LET-326: text-first chip primitives for the read-only Sandbox & runtime
 * dashboard. State chips encode a single tone string that maps to Tailwind
 * tokens; the chip is never identifiable by color alone — the text label is
 * always rendered, and the same Lucide glyph appears for visual consistency.
 */

import type { ReactNode } from "react";
import { ShieldAlert, ShieldCheck, EyeOff, Info, CircleAlert, BadgeCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  SOURCE_CLASS_LABELS,
  REDACTED_DISPLAY,
  type ChipTone,
  type SourceClass,
} from "./eaos-state-labels";

function toneClasses(tone: ChipTone): string {
  switch (tone) {
    case "neutral":
      return "border-border bg-muted/50 text-foreground";
    case "info":
      return "border-sky-400/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "success":
      return "border-emerald-400/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "warn":
      return "border-amber-400/50 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "danger":
      return "border-red-400/50 bg-red-500/10 text-red-700 dark:text-red-300";
  }
}

export interface StateChipProps {
  label: string;
  tone?: ChipTone;
  icon?: ReactNode;
  title?: string;
  ariaLabel?: string;
  className?: string;
}

export function StateChip({
  label,
  tone = "neutral",
  icon,
  title,
  ariaLabel,
  className,
}: StateChipProps) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 border", toneClasses(tone), className)}
      title={title ?? label}
      aria-label={ariaLabel ?? label}
    >
      {icon}
      <span>{label}</span>
    </Badge>
  );
}

export interface SourceClassChipProps {
  source: SourceClass;
  className?: string;
}

export function SourceClassChip({ source, className }: SourceClassChipProps) {
  const meta = SOURCE_CLASS_LABELS[source];
  return (
    <StateChip
      label={meta.label}
      tone={meta.tone}
      icon={<Info aria-hidden="true" className="h-3 w-3" />}
      title={meta.description}
      ariaLabel={`Source: ${meta.label}. ${meta.description}`}
      className={className}
    />
  );
}

export interface PreviewChipProps {
  className?: string;
}

export function PreviewChip({ className }: PreviewChipProps) {
  return (
    <StateChip
      label="Preview"
      tone="warn"
      icon={<EyeOff aria-hidden="true" className="h-3 w-3" />}
      title="Preview-only surface. No live sandbox/network/runtime action is performed."
      className={className}
    />
  );
}

export interface ReadOnlyChipProps {
  className?: string;
}

export function ReadOnlyChip({ className }: ReadOnlyChipProps) {
  return (
    <StateChip
      label="Read-only"
      tone="info"
      icon={<ShieldCheck aria-hidden="true" className="h-3 w-3" />}
      title="No mutating controls exposed by this dashboard slice."
      className={className}
    />
  );
}

export interface RedactedChipProps {
  className?: string;
  /** Optional shorter label for inline value substitution. */
  short?: boolean;
}

export function RedactedChip({ className, short = false }: RedactedChipProps) {
  return (
    <StateChip
      label={short ? "Hidden" : REDACTED_DISPLAY}
      tone="warn"
      icon={<EyeOff aria-hidden="true" className="h-3 w-3" />}
      title="Hidden by policy. Raw values are never rendered by the dashboard."
      ariaLabel="Hidden by policy"
      className={className}
    />
  );
}

export interface ApprovalRequiredChipProps {
  label?: string;
  className?: string;
}

export function ApprovalRequiredChip({ label = "Approval required", className }: ApprovalRequiredChipProps) {
  return (
    <StateChip
      label={label}
      tone="warn"
      icon={<ShieldAlert aria-hidden="true" className="h-3 w-3" />}
      title="Risky controls disabled. An approval would be required if exposed."
      className={className}
    />
  );
}

export interface ReleaseHeldChipProps {
  className?: string;
}

export function ReleaseHeldChip({ className }: ReleaseHeldChipProps) {
  return (
    <StateChip
      label="Release held"
      tone="warn"
      icon={<CircleAlert aria-hidden="true" className="h-3 w-3" />}
      title="A release hold prevents this surface from acting."
      className={className}
    />
  );
}

export interface UnknownChipProps {
  className?: string;
  label?: string;
}

export function UnknownChip({ className, label = "Unknown" }: UnknownChipProps) {
  return (
    <StateChip
      label={label}
      tone="warn"
      icon={<Info aria-hidden="true" className="h-3 w-3" />}
      title="Backend did not return this field. Treated as unknown rather than green."
      className={className}
    />
  );
}

export interface PartialChipProps {
  className?: string;
}

export function PartialChip({ className }: PartialChipProps) {
  return (
    <StateChip
      label="Partial"
      tone="info"
      icon={<Info aria-hidden="true" className="h-3 w-3" />}
      title="Some fields are missing from the backend response."
      className={className}
    />
  );
}

export interface BackendBackedChipProps {
  className?: string;
}

export function BackendBackedChip({ className }: BackendBackedChipProps) {
  return (
    <StateChip
      label="Backend-backed"
      tone="neutral"
      icon={<BadgeCheck aria-hidden="true" className="h-3 w-3" />}
      title="Sourced from a real lease/provider row."
      className={className}
    />
  );
}
