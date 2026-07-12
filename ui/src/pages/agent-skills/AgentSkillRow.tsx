import { Lock, type LucideIcon } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SkillCardIcon, type SkillIconCard } from "../../components/SkillCardIcon";
import type { AgentSkillSearchFields } from "./agent-skill-filter";

export type AgentSkillRowVariant = "enabled" | "available" | "readonly";

export interface AgentSkillRowData extends AgentSkillSearchFields {
  /** Skill key — used as React key and for toggle callbacks. */
  key: string;
  name: string;
  /** Icon inputs (iconUrl / color / slug / key / name). */
  icon: SkillIconCard;
  /** One-line resolved summary (tagline → description → key fallback). */
  summary: string | null;
  /** Small chip label for the primary category. */
  chip?: string | null;
  /** Formatted source/provenance text rendered without badge chrome. */
  sourceMeta?: {
    icon: LucideIcon;
    label: string;
  } | null;
  /** Route to the skill detail page; null makes the row non-navigable. */
  linkTo: string | null;
  /** Read-only metadata (adapter-detected skills). */
  originLabel?: string | null;
  locationLabel?: string | null;
}

export interface AgentSkillRowProps {
  variant: AgentSkillRowVariant;
  data: AgentSkillRowData;
  checked?: boolean;
  disabled?: boolean;
  /** Tooltip shown on a disabled toggle (unsupported adapter). */
  disabledReason?: string | null;
  onCheckedChange?: (checked: boolean) => void;
}

/**
 * Dense presentational row for the agent Skills tab: 32px icon, name (links to
 * the skill detail page), one-line clamped tagline, category chip, source
 * metadata, and a right-aligned toggle (or a lock icon for read-only
 * adapter-detected skills).
 */
export function AgentSkillRow({
  variant,
  data,
  checked = false,
  disabled = false,
  disabledReason,
  onCheckedChange,
}: AgentSkillRowProps) {
  const readOnly = variant === "readonly";
  const SourceIcon = data.sourceMeta?.icon;

  const leading = (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <SkillCardIcon card={data.icon} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{data.name}</span>
          {data.chip ? (
            <span className="hidden shrink-0 items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-(length:--text-nano) capitalize text-muted-foreground sm:inline-flex">
              {data.chip}
            </span>
          ) : null}
        </div>
        {data.summary ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{data.summary}</p>
        ) : null}
        {data.sourceMeta && SourceIcon ? (
          <p className="mt-0.5 flex min-w-0 items-center gap-1 text-(length:--text-nano) text-muted-foreground/80">
            <SourceIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{data.sourceMeta.label}</span>
          </p>
        ) : null}
        {readOnly && data.originLabel ? (
          <p className="mt-0.5 truncate text-(length:--text-nano) text-muted-foreground/80">
            {data.originLabel}
            {data.locationLabel ? ` · ${data.locationLabel}` : ""}
          </p>
        ) : null}
      </div>
    </div>
  );

  const rowClass = cn(
    "flex min-h-11 items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0",
    readOnly ? "bg-muted/20" : "transition-colors hover:bg-accent/50",
  );

  const body = data.linkTo ? (
    <Link
      to={data.linkTo}
      className="flex min-w-0 flex-1 items-center gap-3 no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
    >
      {leading}
    </Link>
  ) : (
    leading
  );

  const trailing = readOnly ? (
    <Lock className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-label="Read-only" />
  ) : (
    (() => {
      const toggle = (
        <ToggleSwitch
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => onCheckedChange?.(next)}
          aria-label={`${checked ? "Disable" : "Enable"} ${data.name}`}
        />
      );
      if (disabled && disabledReason) {
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0">{toggle}</span>
            </TooltipTrigger>
            <TooltipContent side="left">{disabledReason}</TooltipContent>
          </Tooltip>
        );
      }
      return <span className="shrink-0">{toggle}</span>;
    })()
  );

  return (
    <div className={rowClass}>
      {body}
      {trailing}
    </div>
  );
}
