import { i18n, t, useTranslation } from "@/i18n";
import type { IssueRelatedWorkItem, IssueRelatedWorkSummary } from "@paperclipai/shared";
import { IssueReferencePill } from "./IssueReferencePill";
import { ExternalObjectPill } from "./ExternalObjectPill";
import type { IssueExternalObjectGroup } from "../hooks/useIssueExternalObjects";
import { externalObjectToneSeverity } from "../lib/external-objects";
import { Badge } from "@/components/ui/badge";

/** Translate built-in provenance labels only; grouping continues to use the raw labels. */
export function relatedWorkSourceLabelDisplay(label: string, kind?: IssueRelatedWorkItem["sources"][number]["kind"]): string {
  if (i18n.resolvedLanguage === "en") return label;
  if (kind) {
    if (kind === "document") return label === "document" ? t("localizationIssuePanels.source_Document") : label;
    return t(`localizationIssuePanels.source_${kind.charAt(0).toUpperCase() + kind.slice(1)}`);
  }
  const keys: Record<string, string> = { "Title": "localizationIssuePanels.source_Title", "Description": "localizationIssuePanels.source_Description", "Comment": "localizationIssuePanels.source_Comment", "Document": "localizationIssuePanels.source_Document", "Property": "localizationIssuePanels.source_Property", "Plugin": "localizationIssuePanels.source_Plugin", "Source": "localizationIssuePanels.source_Source" };
  if (keys[label]) return t(keys[label]);
  if (label.startsWith("Document: ")) return t("localizationIssuePanels.source_documentNamed", { key: label.slice(10) });
  if (label.startsWith("Property: ")) return t("localizationIssuePanels.source_propertyNamed", { key: label.slice(10) });
  return label;
}

type GroupedSource = {
  label: string;
  count: number;
  sampleMatchedText: string | null;
};

function groupSourcesByLabel(sources: IssueRelatedWorkItem["sources"]): GroupedSource[] {
  const groups = new Map<string, GroupedSource>();
  for (const source of sources) {
    const existing = groups.get(source.label);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(source.label, {
        label: source.label,
        count: 1,
        sampleMatchedText: source.matchedText ?? null,
      });
    }
  }
  return Array.from(groups.values());
}

function Section({
  title,
  description,
  items,
  emptyLabel,
}: {
  title: string;
  description: string;
  items: IssueRelatedWorkItem[];
  emptyLabel: string;
}) {
  useTranslation();
  return (
    <section className="space-y-3 rounded-lg border border-border p-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="-mx-1 flex flex-col">
          {items.map((item) => {
            const groupedSources = groupSourcesByLabel(item.sources);
            const showTitle = item.issue.identifier !== item.issue.title;
            return (
              <li
                key={item.issue.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md px-1 py-1.5 hover:bg-accent/40"
              >
                <IssueReferencePill issue={item.issue} />
                {showTitle ? (
                  <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                    {item.issue.title}
                  </span>
                ) : null}
                <div className="flex flex-wrap items-center gap-1.5">
                  {groupedSources.map((group) => (
                    <Badge variant="outline"
                      key={`${item.issue.id}:${group.label}`}
                      className="border-border bg-muted/40 text-muted-foreground"
                      title={group.sampleMatchedText ?? undefined}
                    >
                      <span>{relatedWorkSourceLabelDisplay(group.label, item.sources.find((source) => source.label === group.label)?.kind)}</span>
                      {group.count > 1 ? (
                        <span className="tabular-nums text-(length:--text-nano) font-medium opacity-80">×{group.count}</span>
                      ) : null}
                    </Badge>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ExternalObjectsSection({
  groups,
  isLoading,
  isError,
  onRetry,
}: {
  groups: IssueExternalObjectGroup[];
  isLoading: boolean;
  isError: boolean;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  // Severity-first sort with most-recently-changed as the secondary sort.
  const sorted = [...groups].sort((a, b) => {
    const aTone = externalObjectToneSeverity(a.pill.statusCategory ? a.group.object?.statusTone ?? null : null);
    const bTone = externalObjectToneSeverity(b.pill.statusCategory ? b.group.object?.statusTone ?? null : null);
    if (aTone !== bTone) return bTone - aTone;
    const aChanged = a.group.object?.lastChangedAt ?? a.group.object?.lastResolvedAt ?? "";
    const bChanged = b.group.object?.lastChangedAt ?? b.group.object?.lastResolvedAt ?? "";
    return aChanged < bChanged ? 1 : aChanged > bChanged ? -1 : 0;
  });

  return (
    <section className="space-y-3 rounded-lg border border-border p-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("localizationIssuePanels.ui_External_objects_1ftlfxm")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("localizationIssuePanels.ui_Remote_work_referenced_from_this_issue_pull_requests_deployments__1jlx213")}
        </p>
      </div>

      {isError ? (
        <p className="text-xs text-muted-foreground">
          {t("localizationIssuePanels.ui_Couldn_t_load_external_objects_lsu0y")}{" "}
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="text-primary underline-offset-2 hover:underline"
            >
              {t("localizationIssuePanels.ui_Retry_zkouah")}
            </button>
          ) : null}
        </p>
      ) : isLoading ? (
        <p className="text-xs text-muted-foreground">{t("localizationIssuePanels.ui_Loading_external_objects_ypq1jo")}</p>
      ) : sorted.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("localizationIssuePanels.ui_This_issue_does_not_reference_any_external_objects_yet_xkbv9w")}
        </p>
      ) : (
        <ul className="-mx-1 flex flex-col">
          {sorted.map(({ pill, mentionCount, sourceLabels, group }) => {
            const object = group.object;
            return (
              <li
                key={object?.id ?? `${pill.providerKey}:${pill.objectType}:${pill.url ?? "anon"}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md px-1 py-1.5 hover:bg-accent/40"
              >
                <ExternalObjectPill object={pill} sourceCount={mentionCount} sourceSummary={sourceLabels.map((label) => relatedWorkSourceLabelDisplay(label)).join(", ")} />
                {pill.displayTitle ? (
                  <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                    {pill.displayTitle}
                  </span>
                ) : null}
                <div className="flex flex-wrap items-center gap-1.5">
                  {sourceLabels.map((label) => (
                    <Badge variant="outline"
                      key={`${object?.id ?? pill.url ?? label}:${label}`}
                      className="border-border bg-muted/40 text-muted-foreground"
                    >
                      <span>{relatedWorkSourceLabelDisplay(label)}</span>
                    </Badge>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function IssueRelatedWorkPanel({
  relatedWork,
  externalObjectsEnabled = true,
  externalObjects,
  externalObjectsLoading,
  externalObjectsError,
  onRetryExternalObjects,
}: {
  relatedWork?: IssueRelatedWorkSummary | null;
  externalObjectsEnabled?: boolean;
  externalObjects?: IssueExternalObjectGroup[];
  externalObjectsLoading?: boolean;
  externalObjectsError?: boolean;
  onRetryExternalObjects?: () => void;
}) {
  const { t } = useTranslation();
  const outbound = relatedWork?.outbound ?? [];
  const inbound = relatedWork?.inbound ?? [];

  return (
    <div className="space-y-3">
      <Section
        title={t("localizationIssuePanels.ui_References_1p1yprf")}
        description={t("localizationIssuePanels.ui_Other_tasks_this_task_currently_points_at_in_its_title_descriptio_1av8m2s")}
        items={outbound}
        emptyLabel={t("localizationIssuePanels.ui_This_task_does_not_reference_any_other_tasks_yet_1auy0er")}
      />
      {externalObjectsEnabled ? (
        <ExternalObjectsSection
          groups={externalObjects ?? []}
          isLoading={Boolean(externalObjectsLoading)}
          isError={Boolean(externalObjectsError)}
          onRetry={onRetryExternalObjects}
        />
      ) : null}
      <Section
        title={t("localizationIssuePanels.ui_Referenced_by_1es59lz")}
        description={t("localizationIssuePanels.ui_Other_tasks_that_currently_point_at_this_task_8139qu")}
        items={inbound}
        emptyLabel={t("localizationIssuePanels.ui_No_other_tasks_reference_this_task_yet_cneg2m")}
      />
    </div>
  );
}
