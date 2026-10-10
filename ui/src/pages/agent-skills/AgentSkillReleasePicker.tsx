import type { CompanySkillVersion } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Sentinel value for the "no pin / live default" option (Radix forbids ""). */
export const RELEASE_DEFAULT_VALUE = "default";

const DEFAULT_LABEL = "Default — current (recommended)";

/**
 * Render a bundled release's calendar date. Plain `YYYY-MM-DD` strings (like the
 * v7-roster manifest entry) render verbatim; full timestamps collapse to their
 * local calendar day so the picker reads `released 2026-07-21`.
 */
export function formatReleaseDate(value: CompanySkillVersion["releasedAt"]): string | null {
  if (!value) return null;
  const raw = typeof value === "string" ? value : value.toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Release display name, e.g. `V7 — Roster champion` (no date). */
export function releaseName(release: CompanySkillVersion): string {
  return release.releaseName ?? release.label ?? release.releaseId ?? "Release";
}

/** Full option label, e.g. `V7 — Roster champion · released 2026-07-21`. */
export function releaseOptionLabel(release: CompanySkillVersion): string {
  const name = releaseName(release);
  const date = formatReleaseDate(release.releasedAt);
  return date ? `${name} · released ${date}` : name;
}

/** Compact badge label for a pinned release, e.g. `V7`. */
export function releaseShortLabel(release: CompanySkillVersion): string {
  const name = release.releaseName ?? release.label ?? release.releaseId ?? "Release";
  return name.split(" — ")[0]!.trim();
}

export interface AgentSkillReleasePickerProps {
  releases: CompanySkillVersion[];
  /** Currently pinned version id, or null for the live default. */
  value: string | null;
  disabled?: boolean;
  onChange: (versionId: string | null) => void;
}

/**
 * Release picker for the paperclip core skill. Only rendered when the
 * `enableBetaSkills` experimental flag is on and the skill has seeded releases.
 * Selecting a release pins the agent to that frozen snapshot; "Default" clears
 * the pin and returns the agent to the live skill.
 */
export function AgentSkillReleasePicker({
  releases,
  value,
  disabled = false,
  onChange,
}: AgentSkillReleasePickerProps) {
  const selected = value ? releases.find((release) => release.id === value) ?? null : null;
  // Closed trigger shows the release name only; the `· released <date>` suffix
  // lives in the open menu, where dates are meaningful for comparing options.
  const triggerLabel = selected ? releaseName(selected) : DEFAULT_LABEL;

  return (
    <Select
      value={value ?? RELEASE_DEFAULT_VALUE}
      disabled={disabled}
      onValueChange={(next) => onChange(next === RELEASE_DEFAULT_VALUE ? null : next)}
    >
      <SelectTrigger
        size="sm"
        className="w-full max-w-(--sz-16rem) sm:w-(--sz-16rem)"
        aria-label="Skill release"
      >
        <SelectValue placeholder={DEFAULT_LABEL}>{triggerLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="max-w-(--sz-20rem)">
        <SelectItem value={RELEASE_DEFAULT_VALUE}>{DEFAULT_LABEL}</SelectItem>
        {releases.map((release) => (
          <SelectItem key={release.id} value={release.id}>
            <span className="flex items-center gap-2">
              <span className="truncate">{releaseOptionLabel(release)}</span>
              <Badge variant="secondary" className="shrink-0 text-(length:--text-nano)">
                Beta
              </Badge>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
