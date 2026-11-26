import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ToolCatalogEntry, ToolConnection } from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { describeError } from "@/api/errors";
import { QueryErrorState } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { installStateFrom } from "@/lib/tool-installs";
import { queryKeys } from "@/lib/queryKeys";
import { ANALYTICS_MASK_CLASS } from "@/lib/analytics/privacy";
import { cn } from "@/lib/utils";
import { actionLabel, actionPermissionMutation } from "./app-detail/action-permissions";
import { accessFrom, askFirstCatalogIds, enabledCatalogIds } from "./app-detail/saved-permissions";
import { useConnectionPermissionSave } from "./app-detail/useConnectionPermissionSave";

export type ActionPolicy = "allowed" | "ask" | "off";

const POLICY_ORDER: ActionPolicy[] = ["allowed", "ask", "off"];
const POLICY_LABEL: Record<ActionPolicy, string> = { allowed: "Allowed", ask: "Ask first", off: "Off" };
const TONE: Record<ActionPolicy | "custom", string> = {
  allowed: "text-foreground",
  ask: "text-(--status-task-icon-todo)",
  off: "text-muted-foreground",
  custom: "text-foreground",
};

/** The policy an action has today: off unless enabled, and Ask first only while enabled. */
export function actionPolicy(id: string, enabledIds: ReadonlySet<string>, askFirstIds: ReadonlySet<string>): ActionPolicy {
  if (!enabledIds.has(id)) return "off";
  return askFirstIds.has(id) ? "ask" : "allowed";
}

/** One policy when every action in the group shares it, otherwise "custom". */
export function groupPolicy(ids: readonly string[], enabledIds: ReadonlySet<string>, askFirstIds: ReadonlySet<string>): ActionPolicy | "custom" {
  const first = actionPolicy(ids[0], enabledIds, askFirstIds);
  return ids.every((id) => actionPolicy(id, enabledIds, askFirstIds) === first) ? first : "custom";
}

function PolicyMenu({ value, label, disabled, onChange }: { value: ActionPolicy | "custom"; label: string; disabled: boolean; onChange: (next: ActionPolicy) => void }) {
  const text = value === "custom" ? "Custom" : POLICY_LABEL[value];
  if (disabled) return <span className={cn("shrink-0 text-sm", TONE[value])}>{text}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className={cn("-mr-2 h-8 shrink-0", TONE[value])} aria-label={`${label}: ${text}`}>
          {text}
          <ChevronDown className="text-muted-foreground" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={cn("w-40", ANALYTICS_MASK_CLASS)}>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as ActionPolicy)}>
          {POLICY_ORDER.map((policy) => (
            <DropdownMenuRadioItem key={policy} value={policy}>
              {POLICY_LABEL[policy]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActionBlock({
  title,
  entries,
  enabledIds,
  askFirstIds,
  disabled,
  onChange,
}: {
  title: string;
  entries: ToolCatalogEntry[];
  enabledIds: ReadonlySet<string>;
  askFirstIds: ReadonlySet<string>;
  disabled: boolean;
  onChange: (ids: string[], next: ActionPolicy) => void;
}) {
  const [open, setOpen] = useState(false);
  const region = useId();
  const ids = entries.map((entry) => entry.id);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="flex flex-col rounded-2xl bg-muted/50">
      <div className="flex h-12 items-center justify-between gap-4 px-4">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={region}
          onClick={() => setOpen((current) => !current)}
          className="-ml-1 flex h-8 items-center gap-2 rounded-md pr-2 pl-1 text-sm font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Chevron className="size-4 text-muted-foreground" aria-hidden />
          {title}
          <span className="font-normal text-muted-foreground tabular-nums">{entries.length}</span>
        </button>
        <PolicyMenu value={groupPolicy(ids, enabledIds, askFirstIds)} label={`All ${title.toLowerCase()}`} disabled={disabled} onChange={(next) => onChange(ids, next)} />
      </div>
      <ul id={region} hidden={!open} className="flex flex-col pb-2">
        {entries.map((entry) => {
          const label = actionLabel(entry);
          return (
            <li key={entry.id} className="flex min-h-10 items-center justify-between gap-4 pr-4 pl-11">
              <span className="flex min-w-0 items-baseline gap-2.5">
                <span className="truncate text-sm text-foreground">{label}</span>
                {label === entry.toolName ? null : <span className="truncate font-mono text-xs text-muted-foreground">{entry.toolName}</span>}
              </span>
              <PolicyMenu value={actionPolicy(entry.id, enabledIds, askFirstIds)} label={label} disabled={disabled} onChange={(next) => onChange([entry.id], next)} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const NOTE = "rounded-2xl bg-muted/50 px-4 py-3 text-sm text-muted-foreground";

function ConnectionPermissions({ companyId, connection }: { companyId: string; connection: ToolConnection }) {
  const connectionId = connection.id;
  const [saveError, setSaveError] = useState<string | null>(null);
  const catalogQuery = useQuery({ queryKey: queryKeys.tools.catalog(connectionId), queryFn: () => toolsApi.listCatalog(connectionId) });
  const profilesQuery = useQuery({
    queryKey: queryKeys.tools.connectionProfileConfiguration(companyId, connectionId),
    queryFn: ({ signal }) => toolsApi.listConnectionProfileConfiguration(connectionId, { signal, fresh: true }),
  });
  const policiesQuery = useQuery({
    queryKey: queryKeys.tools.policies(companyId),
    queryFn: ({ signal }) => toolsApi.listPolicies(companyId, { signal, fresh: true }),
  });
  const installsQuery = useQuery({
    queryKey: queryKeys.tools.connectionInstalls(connectionId),
    queryFn: ({ signal }) => toolsApi.getConnectionInstalls(connectionId, { signal, fresh: true }),
  });
  const grantsQuery = useQuery({
    queryKey: queryKeys.tools.connectionGrants(connectionId),
    queryFn: ({ signal }) => toolsApi.listConnectionGrants(connectionId, { signal }),
  });
  const { draft, pending, save } = useConnectionPermissionSave({
    companyId,
    connectionId,
    connection,
    catalog: catalogQuery.data?.catalog ?? [],
    onError: (error) => setSaveError(describeError(error).body),
  });

  const { reads, writes } = useMemo(() => {
    const byName = (left: ToolCatalogEntry, right: ToolCatalogEntry) => actionLabel(left).localeCompare(actionLabel(right));
    const active = (catalogQuery.data?.catalog ?? []).filter((entry) => entry.status === "active");
    return { reads: active.filter((entry) => entry.isReadOnly).sort(byName), writes: active.filter((entry) => !entry.isReadOnly).sort(byName) };
  }, [catalogQuery.data]);
  const profile = useMemo(() => (profilesQuery.data?.profiles ?? []).find((entry) => entry.profileKey === `app:${connectionId}`), [profilesQuery.data, connectionId]);
  const savedEnabled = useMemo(() => enabledCatalogIds(profile), [profile]);
  const savedAskFirst = useMemo(() => askFirstCatalogIds(policiesQuery.data?.policies ?? [], connectionId), [policiesQuery.data, connectionId]);
  const savedAccess = useMemo(() => accessFrom(profile, installStateFrom(installsQuery.data?.installs ?? connection.installs)), [profile, installsQuery.data, connection.installs]);
  const enabledIds = draft?.enabled ?? savedEnabled;
  const askFirstIds = draft?.askFirst ?? savedAskFirst;

  // A failed read only blocks the section while it has nothing to show; a failed
  // background refresh keeps the loaded actions on screen.
  const queries = [catalogQuery, profilesQuery, policiesQuery, installsQuery, grantsQuery];
  const unloaded = queries.filter((query) => query.error != null && query.data === undefined);
  if (unloaded.length > 0) {
    return (
      <QueryErrorState
        error={unloaded[0].error}
        action="load this account’s actions"
        onRetry={() => unloaded.forEach((query) => void query.refetch())}
        retrying={unloaded.some((query) => query.isFetching)}
      />
    );
  }
  const loaded = queries.every((query) => query.data !== undefined);
  if (!loaded) return <p className={NOTE}>Loading actions…</p>;
  if (reads.length + writes.length === 0) return <p className={NOTE}>This account hasn’t listed any actions yet.</p>;

  // After a failed refresh the values on screen may be out of date, and a save replaces what is stored,
  // so changes wait until every read succeeds again.
  const stale = staleReads(queries);
  const canConfigure = grantsQuery.data?.capabilities?.canConfigure === true && stale.length === 0;
  const change = (ids: string[], next: ActionPolicy) => {
    setSaveError(null);
    save({ ...actionPermissionMutation(ids, next, enabledIds, askFirstIds), access: savedAccess });
  };
  return (
    <>
      {reads.length > 0 ? <ActionBlock title="Reads" entries={reads} enabledIds={enabledIds} askFirstIds={askFirstIds} disabled={!canConfigure || pending} onChange={change} /> : null}
      {writes.length > 0 ? <ActionBlock title="Writes" entries={writes} enabledIds={enabledIds} askFirstIds={askFirstIds} disabled={!canConfigure || pending} onChange={change} /> : null}
      {stale.length > 0 ? (
        <p role="status" className="flex flex-wrap items-center gap-x-2 px-4 text-sm text-muted-foreground">
          Couldn’t refresh these permissions, so changes are paused.
          <Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={stale.some((query) => query.isFetching)} onClick={() => stale.forEach((query) => void query.refetch())}>
            Try again
          </Button>
        </p>
      ) : null}
      {saveError ? (
        <p role="alert" className="px-4 text-sm text-destructive">
          Couldn’t save that. {saveError}
        </p>
      ) : null}
    </>
  );
}

/** The reads whose last attempt failed: what they loaded earlier may no longer match what is saved. */
export function staleReads<T extends { error: unknown }>(reads: readonly T[]): T[] {
  return reads.filter((read) => read.error != null);
}

/** Tool permissions for a connected plugin: one block for what it reads and one for what it changes, per account. */
export function PluginPermissions({
  companyId,
  connections,
  accountName,
  onNavigate,
}: {
  companyId: string;
  connections: readonly ToolConnection[];
  accountName: (connection: ToolConnection) => string;
  onNavigate: (href: string) => void;
}) {
  const tools = connections.filter((connection) => connection.connectionPurpose !== "ai");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = tools.find((connection) => connection.id === selectedId) ?? tools[0];
  if (!selected) return null;
  return (
    <section aria-labelledby="plugin-permissions-title" className="flex flex-col gap-2">
      <div className="flex min-h-8 items-center justify-between gap-4 px-4">
        <h2 id="plugin-permissions-title" className="text-sm text-muted-foreground">
          Tool permissions
        </h2>
        {tools.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="-mr-2 h-8 max-w-64 text-muted-foreground" aria-label={`Account: ${accountName(selected)}`}>
                <span className="truncate">{accountName(selected)}</span>
                <ChevronDown aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={ANALYTICS_MASK_CLASS}>
              <DropdownMenuRadioGroup value={selected.id} onValueChange={setSelectedId}>
                {tools.map((connection) => (
                  <DropdownMenuRadioItem key={connection.id} value={connection.id}>
                    {accountName(connection)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <ConnectionPermissions key={selected.id} companyId={companyId} connection={selected} />
      <p className="px-4 text-xs text-muted-foreground">
        Ask first sends the action to Review before it runs.{" "}
        <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => onNavigate(`/apps/${selected.id}/permissions`)}>
          Agent access and more settings
        </button>
      </p>
    </section>
  );
}
