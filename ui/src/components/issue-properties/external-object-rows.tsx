import { t, useTranslation } from "@/i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { IssueExternalObjectGroup } from "../../hooks/useIssueExternalObjects";
import {
  externalObjectDisplayStatusLabel,
  externalObjectDisplayLabel,
  externalObjectIconForKey,
  externalObjectProviderLabel,
  externalObjectToneSeverity,
  externalObjectTypeLabel,
} from "../../lib/external-objects";
import {
  externalObjectStatusIcon,
  externalObjectStatusIconDefault,
} from "../../lib/status-colors";
import { cn } from "../../lib/utils";
import { ExternalObjectStatusIcon } from "../ExternalObjectStatusIcon";
import { PropertyRow } from "./primitives";
import { ExpandRelationListButton } from "./relation-controls";

const EXTERNAL_OBJECT_PROPERTY_PREVIEW_COUNT = 5;

function sortExternalObjectGroups(groups: IssueExternalObjectGroup[]) {
  return [...groups].sort((a, b) => {
    const aTone = externalObjectToneSeverity(a.group.object?.statusTone);
    const bTone = externalObjectToneSeverity(b.group.object?.statusTone);
    return bTone - aTone;
  });
}

function externalObjectRowDisplayKey(group: IssueExternalObjectGroup): string {
  const { pill } = group;
  const displayKey = pill.displayKey?.trim();
  if (displayKey) return displayKey;
  if (pill.providerKey === "github") {
    if (pill.objectType === "pull_request") return t("localizationIssueDetail.githubPr");
    if (pill.objectType === "issue") return t("localizationIssueDetail.githubIssue");
  }
  return externalObjectDisplayLabel(pill.providerKey, pill.objectType);
}

function externalObjectRowLabel(group: IssueExternalObjectGroup): ReactNode {
  const { pill } = group;
  const displayKey = externalObjectRowDisplayKey(group);
  const Icon = externalObjectIconForKey(pill.iconKey);
  return (
    <span className="inline-flex min-w-0 items-start gap-1" title={displayKey}>
      {Icon ? <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 mt-0.5" /> : null}
      <span className="truncate">{displayKey}</span>
    </span>
  );
}

function githubObjectPropertyValue(url: string | null | undefined): string | null {
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

function externalObjectPropertyStatusLabel(group: IssueExternalObjectGroup): string {
  return externalObjectDisplayStatusLabel(group.pill);
}

function externalObjectPropertyValue(group: IssueExternalObjectGroup): string {
  const { pill } = group;
  const statusLabel = externalObjectPropertyStatusLabel(group);
  const githubLabel = pill.providerKey === "github" ? githubObjectPropertyValue(pill.url) : null;
  const base = githubLabel ?? pill.displayTitle?.trim() ?? externalObjectRowDisplayKey(group);
  return statusLabel ? t("localizationExternalChrome.valueStatus", { value: base, status: statusLabel }) : base;
}

function isMergedExternalObject(group: IssueExternalObjectGroup): boolean {
  const rawStatus = group.pill.statusLabel?.trim() || group.pill.statusCategory;
  return group.pill.statusIconKey === "git-merge" || rawStatus.toLowerCase() === "merged";
}

function externalObjectPropertyTone(group: IssueExternalObjectGroup): string {
  const tone = isMergedExternalObject(group)
    ? externalObjectStatusIcon.merged
    : externalObjectStatusIcon[group.pill.statusCategory] ?? externalObjectStatusIconDefault;
  return tone.split(" ").filter((c) => c.startsWith("text-")).join(" ");
}

function externalObjectPropertyStatusIconKey(group: IssueExternalObjectGroup): string | null | undefined {
  if (isMergedExternalObject(group)) return group.pill.statusIconKey ?? "git-merge";
  return group.pill.statusIconKey;
}

function externalObjectPropertyTitle(group: IssueExternalObjectGroup): string {
  const { pill, sourceLabels } = group;
  const base = pill.displayTitle ?? externalObjectPropertyValue(group);
  return sourceLabels.length > 0 ? t("localizationExternalChrome.propertySourceTitle", { title: base, sources: sourceLabels.join(", ") }) : base;
}

function ExternalObjectPropertyValue({ group }: { group: IssueExternalObjectGroup }) {
  const { t } = useTranslation();
  const { pill } = group;
  const statusLabel = externalObjectPropertyStatusLabel(group);
  const providerLabel = externalObjectProviderLabel(pill.providerKey);
  const typeLabel = externalObjectTypeLabel(pill.objectType);
  const value = externalObjectPropertyValue(group);
  const content = (
    <>
      <ExternalObjectStatusIcon
        category={pill.statusCategory}
        liveness={pill.liveness}
        statusIconKey={externalObjectPropertyStatusIconKey(group)}
        sizeClassName="h-3.5 w-3.5"
        label={t("localizationExternalChrome.providerStatus", { provider: providerLabel, status: statusLabel })}
      />
      <span className="min-w-0 truncate">{value}</span>
    </>
  );
  const className = cn(
    "inline-flex min-w-0 max-w-full items-center gap-1.5 text-sm no-underline",
    externalObjectPropertyTone(group),
    pill.url ? "hover:underline focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring" : "",
  );

  if (pill.url) {
    return (
      <a
        href={pill.url}
        target="_blank"
        rel="noopener noreferrer"
        data-mention-kind="external-object"
        data-external-status={pill.statusCategory}
        data-external-liveness={pill.liveness}
        className={className}
        title={externalObjectPropertyTitle(group)}
        aria-label={t("localizationExternalChrome.propertyAria", { provider: providerLabel, type: typeLabel, status: statusLabel, title: pill.displayTitle ?? value })}
      >
        {content}
      </a>
    );
  }

  return (
    <span
      data-mention-kind="external-object"
      data-external-status={pill.statusCategory}
      data-external-liveness={pill.liveness}
      className={className}
      title={externalObjectPropertyTitle(group)}
      aria-label={t("localizationExternalChrome.propertyAria", { provider: providerLabel, type: typeLabel, status: statusLabel, title: pill.displayTitle ?? value })}
    >
      {content}
    </span>
  );
}

export function ExternalObjectRows({
  externalObjects,
  externalObjectsLoading,
  externalObjectsError,
  onRetryExternalObjects,
}: {
  externalObjects?: IssueExternalObjectGroup[];
  externalObjectsLoading?: boolean;
  externalObjectsError?: boolean;
  onRetryExternalObjects?: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const previousExternalObjects = useRef(externalObjects);

  useEffect(() => {
    const previous = previousExternalObjects.current;
    previousExternalObjects.current = externalObjects;
    // Translated source labels create new UI groups, but do not change the underlying records.
    if (previous?.length === externalObjects?.length
      && externalObjects?.every((entry, index) => entry.group === previous?.[index]?.group)) return;
    setExpanded(false);
  }, [externalObjects]);

  if (externalObjectsError) {
    return (
      <PropertyRow label={t("localizationIssueDetail.ui_External_objects")}>
        <span className="text-xs text-muted-foreground">
          {t("localizationIssueDetail.ui_Couldn_t_load_external_objects")}
          {onRetryExternalObjects ? (
            <>
              {" "}
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                onClick={onRetryExternalObjects}
              >
                {t("pages.inbox.retry")}
              </button>
            </>
          ) : null}
        </span>
      </PropertyRow>
    );
  }

  if (externalObjectsLoading) {
    return (
      <PropertyRow label={t("localizationIssueDetail.ui_External_objects")}>
        <span className="h-4 w-24 animate-pulse rounded bg-muted/40" />
      </PropertyRow>
    );
  }

  if (!externalObjects || externalObjects.length === 0) return null;

  const sortedExternalObjects = sortExternalObjectGroups(externalObjects);
  const visibleExternalObjects = expanded
    ? sortedExternalObjects
    : sortedExternalObjects.slice(0, EXTERNAL_OBJECT_PROPERTY_PREVIEW_COUNT);
  const hiddenExternalObjectCount = sortedExternalObjects.length - visibleExternalObjects.length;

  return (
    <>
      {visibleExternalObjects
        .map((externalObject) => {
          const { pill, group } = externalObject;
          return (
            <PropertyRow
              key={group.object?.id ?? `${pill.providerKey}:${pill.objectType}:${pill.url ?? "anon"}`}
              label={externalObjectRowLabel(externalObject)}
            >
              <ExternalObjectPropertyValue group={externalObject} />
            </PropertyRow>
          );
        })}
      {expanded || hiddenExternalObjectCount > 0 ? (
        <PropertyRow label={t("pages.secrets.fields.references")}>
          <ExpandRelationListButton
            hiddenCount={hiddenExternalObjectCount}
            expanded={expanded}
            onClick={() => setExpanded((next) => !next)}
          />
        </PropertyRow>
      ) : null}
    </>
  );
}
