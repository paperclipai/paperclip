import { t, useTranslation } from "@/i18n";
import type { ReactNode } from "react";
import type {
  ExternalObjectLivenessState,
  ExternalObjectStatusCategory,
} from "@paperclipai/shared";
import { ExternalObjectStatusIcon } from "./ExternalObjectStatusIcon";
import {
  externalObjectStatusIcon,
  externalObjectStatusIconDefault,
  externalObjectLivenessOverlay,
} from "../lib/status-colors";
import {
  externalObjectDisplayStatusLabel,
  externalObjectDisplayLabel,
  externalObjectLivenessLabel,
  externalObjectIconForKey,
  externalObjectProviderLabel,
} from "../lib/external-objects";
import { cn } from "../lib/utils";

export interface ExternalObjectPillData {
  providerKey: string | null;
  objectType: string | null;
  displayKey?: string | null;
  iconKey?: string | null;
  statusCategory: ExternalObjectStatusCategory;
  liveness: ExternalObjectLivenessState;
  displayTitle?: string | null;
  statusLabel?: string | null;
  statusIconKey?: string | null;
  url?: string | null;
}

function githubObjectLabel(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    const [, owner, repo, kind, number] = parsed.pathname.split("/");
    if (!owner || !repo || !number) return null;
    if (kind === "pull") return t("localizationIssueDetail.prNumber", { number });
    if (kind === "issues") return t("localizationIssueDetail.issueNumber", { number });
    return null;
  } catch {
    return null;
  }
}

function externalObjectValueLabel(
  object: ExternalObjectPillData,
  fallback: string,
  statusLabel: string,
): string {
  const githubLabel = object.providerKey === "github" ? githubObjectLabel(object.url) : null;
  const base = githubLabel ?? object.displayTitle?.trim() ?? fallback;
  return statusLabel ? t("localizationExternalChrome.valueStatus", { value: base, status: statusLabel }) : base;
}

function isMergedExternalObject(object: ExternalObjectPillData): boolean {
  const rawStatus = object.statusLabel?.trim() || object.statusCategory;
  return object.statusIconKey === "git-merge" || rawStatus.toLowerCase() === "merged";
}

function externalObjectPillTone(object: ExternalObjectPillData): string {
  if (isMergedExternalObject(object)) {
    return "text-violet-600 border-violet-600 dark:text-violet-400 dark:border-violet-400";
  }
  return externalObjectStatusIcon[object.statusCategory] ?? externalObjectStatusIconDefault;
}

function externalObjectStatusIconKey(
  object: ExternalObjectPillData,
): string | null | undefined {
  if (isMergedExternalObject(object)) return object.statusIconKey ?? "git-merge";
  return object.statusIconKey;
}

interface ExternalObjectPillProps {
  object: ExternalObjectPillData;
  /** Optional external mention count (renders as `×N` superscript when > 1). */
  sourceCount?: number;
  /** Optional source-mention summary used as the pill's `title` attribute. */
  sourceSummary?: string | null;
  className?: string;
  /** Optional rendered label override. Defaults to `provider object-type`. */
  children?: ReactNode;
  /**
   * If true the pill renders without a hover treatment (used inside
   * non-interactive contexts like the property panel). Defaults to false.
   */
  inert?: boolean;
  /**
   * Hide the provider icon when the surrounding UI already names the provider.
   * The status icon still renders as the single state glyph inside the pill.
   */
  showProviderIcon?: boolean;
}

/**
 * External-object equivalent of `IssueReferencePill`. Same `paperclip-mention-chip`
 * base so external references feel native to readers (Jakob's Law).
 */
export function ExternalObjectPill({
  object,
  sourceCount,
  sourceSummary,
  className,
  children,
  inert,
  showProviderIcon = true,
}: ExternalObjectPillProps) {
  const { t } = useTranslation();
  const overlay = externalObjectLivenessOverlay[object.liveness] ?? "";
  const providerLabel = externalObjectProviderLabel(object.providerKey);
  const displayKey = externalObjectDisplayLabel(object.providerKey, object.objectType, object.displayKey);
  const statusLabel = externalObjectDisplayStatusLabel(object);
  const tone = externalObjectPillTone(object);
  const valueLabel = externalObjectValueLabel(object, displayKey, statusLabel);
  const statusIconKey = externalObjectStatusIconKey(object);
  const livenessLabel = externalObjectLivenessLabel(object.liveness);
  const ProviderIcon = externalObjectIconForKey(object.iconKey);
  const ariaKey = displayKey;
  const showLiveness = object.liveness !== "fresh" && object.liveness !== "unknown";
  const ariaLabel = object.displayTitle
    ? showLiveness
      ? t("localizationExternalChrome.objectAriaLiveTitle", { key: ariaKey, status: statusLabel, liveness: livenessLabel, title: object.displayTitle })
      : t("localizationExternalChrome.objectAriaTitle", { key: ariaKey, status: statusLabel, title: object.displayTitle })
    : showLiveness
      ? t("localizationExternalChrome.objectAriaLive", { key: ariaKey, status: statusLabel, liveness: livenessLabel })
      : t("localizationExternalChrome.objectAria", { key: ariaKey, status: statusLabel });

  const interactive = !inert && Boolean(object.url);
  const classNames = cn(
    "paperclip-mention-chip paperclip-mention-chip--external-object",
    "inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs no-underline",
    // Tone is applied as text classes only — the border style comes from the
    // overlay (dashed for stale/auth/unreachable).
    tone.split(" ").filter((c) => c.startsWith("text-")).join(" "),
    overlay,
    interactive
      && "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring",
    className,
  );
  const titleAttr = sourceSummary
    ? t("localizationExternalChrome.objectSourceTitle", { title: object.displayTitle ?? displayKey, source: sourceSummary })
    : object.displayTitle ?? displayKey;
  const labelText = children ?? (
    <>
      <ExternalObjectStatusIcon
        category={object.statusCategory}
        liveness={object.liveness}
        statusIconKey={statusIconKey}
        sizeClassName="h-3 w-3"
        label={t("localizationExternalChrome.providerStatus", { provider: providerLabel, status: statusLabel })}
      />
      <span className="max-w-(--sz-16rem) truncate font-medium">{valueLabel}</span>
    </>
  );
  const countSuffix = typeof sourceCount === "number" && sourceCount > 1 ? (
    <span className="tabular-nums text-(length:--text-nano) font-medium opacity-80">×{sourceCount}</span>
  ) : null;
  const innerContent = (
    <>
      {showProviderIcon && ProviderIcon ? (
        <ProviderIcon aria-hidden="true" className="h-3 w-3 shrink-0" />
      ) : null}
      <span className="inline-flex min-w-0 items-center gap-1">
        {labelText}
      </span>
      {countSuffix}
    </>
  );

  if (interactive && object.url) {
    return (
      <a
        href={object.url}
        target="_blank"
        rel="noopener noreferrer"
        data-mention-kind="external-object"
        data-external-status={object.statusCategory}
        data-external-liveness={object.liveness}
        className={classNames}
        title={titleAttr}
        aria-label={ariaLabel}
      >
        {innerContent}
      </a>
    );
  }

  return (
    <span
      data-mention-kind="external-object"
      data-external-status={object.statusCategory}
      data-external-liveness={object.liveness}
      className={classNames}
      title={titleAttr}
      aria-label={ariaLabel}
    >
      {innerContent}
    </span>
  );
}
