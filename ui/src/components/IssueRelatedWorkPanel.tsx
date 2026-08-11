import type { IssueRelatedWorkItem, IssueRelatedWorkSummary } from "@paperclipai/shared";
import { IssueReferencePill } from "./IssueReferencePill";
import { ExternalObjectPill } from "./ExternalObjectPill";
import type { IssueExternalObjectGroup } from "../hooks/useIssueExternalObjects";
import { externalObjectToneSeverity } from "../lib/external-objects";
import { Badge } from "@/components/ui/badge";

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
                      <span>{group.label}</span>
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
        <h3 className="text-sm font-semibold">External objects</h3>
        <p className="text-xs text-muted-foreground">
          Remote work referenced from this issue — pull requests, deployments, tickets in other systems, and more.
        </p>
      </div>

      {isError ? (
        <p className="text-xs text-muted-foreground">
          Couldn't load external objects.{" "}
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="text-primary underline-offset-2 hover:underline"
            >
              Retry
            </button>
          ) : null}
        </p>
      ) : isLoading ? (
        <p className="text-xs text-muted-foreground">Loading external objects…</p>
      ) : sorted.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This issue does not reference any external objects yet.
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
                <ExternalObjectPill object={pill} sourceCount={mentionCount} sourceSummary={sourceLabels.join(", ")} />
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
                      <span>{label}</span>
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
  const outbound = relatedWork?.outbound ?? [];
  const inbound = relatedWork?.inbound ?? [];

  return (
    <div className="space-y-3">
      <Section
        title="References"
        description="Other tasks this task currently points at in its title, description, comments, or documents."
        items={outbound}
        emptyLabel="This task does not reference any other tasks yet."
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
        title="Referenced by"
        description="Other tasks that currently point at this task."
        items={inbound}
        emptyLabel="No other tasks reference this task yet."
      />
    </div>
  );
}
