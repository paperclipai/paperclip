import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Inbox,
  Loader2,
  Plus,
  Puzzle,
  Repeat,
  Trash2,
  Webhook,
} from "lucide-react";
import type {
  ConnectionTriggerDestinationType,
  ConnectionTriggerRecord,
} from "@/api/tools";
import { toolsApi } from "@/api/tools";
import { routinesApi } from "@/api/routines";
import { pluginsApi } from "@/api/plugins";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { RadioCardGroup } from "@/components/ui/radio-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn, relativeTime } from "@/lib/utils";

/** A connection may route inbound webhooks to at most this many destinations. */
const TRIGGER_LIMIT = 3;

type KindMeta = {
  label: string;
  icon: typeof Repeat;
  /** What the destination id points at, in plain language. */
  noun: string;
  blurb: string;
};

const KIND_META: Record<ConnectionTriggerDestinationType, KindMeta> = {
  routine: {
    label: "Routine",
    icon: Repeat,
    noun: "routine",
    blurb: "Run a routine each time this connection receives a webhook.",
  },
  issue_wake: {
    label: "Issue wake",
    icon: Inbox,
    noun: "issue",
    blurb: "Wake an issue's assigned agent when a webhook arrives.",
  },
  plugin_worker: {
    label: "Plugin worker",
    icon: Puzzle,
    noun: "plugin",
    blurb: "Hand the raw webhook to a plugin worker's handler.",
  },
};

const KIND_ORDER: ConnectionTriggerDestinationType[] = ["routine", "issue_wake", "plugin_worker"];

export function TriggersPanel({ connectionId, appName }: { connectionId: string; appName: string }) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const triggersQuery = useQuery({
    queryKey: queryKeys.tools.connectionTriggers(connectionId),
    queryFn: () => toolsApi.listConnectionTriggers(connectionId),
    enabled: !!connectionId,
  });
  const deliveriesQuery = useQuery({
    queryKey: queryKeys.tools.connectionDeliveries(connectionId),
    queryFn: () => toolsApi.getConnectionTriggerDeliveries(connectionId),
    enabled: !!connectionId,
  });

  const triggers = triggersQuery.data?.triggers ?? [];
  const atLimit = triggers.length >= TRIGGER_LIMIT;

  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ConnectionTriggerRecord | null>(null);

  // Destination directories — power both the list labels and the create-form
  // pickers. Only fetched once there's something to label or a form to fill.
  const wantDirectories = triggers.length > 0 || createOpen;
  const routinesQuery = useQuery({
    queryKey: queryKeys.routines.list(selectedCompanyId ?? "__none__"),
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && wantDirectories,
  });
  const pluginsQuery = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
    enabled: wantDirectories,
  });
  const issuesQuery = useQuery({
    queryKey: ["tools", "connection", connectionId, "trigger-issues", selectedCompanyId ?? "__none__"],
    queryFn: () => issuesApi.listCompact(selectedCompanyId!),
    enabled: !!selectedCompanyId && wantDirectories,
  });

  const routineLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of routinesQuery.data ?? []) map.set(r.id, r.title);
    return map;
  }, [routinesQuery.data]);
  const pluginLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of pluginsQuery.data ?? []) map.set(p.id, p.pluginKey);
    return map;
  }, [pluginsQuery.data]);
  const issueLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issuesQuery.data ?? []) map.set(i.id, `${i.identifier} · ${i.title}`);
    return map;
  }, [issuesQuery.data]);

  const labelFor = (trigger: ConnectionTriggerRecord): string | null => {
    if (trigger.destinationType === "routine") return routineLabel.get(trigger.destinationId) ?? null;
    if (trigger.destinationType === "issue_wake") return issueLabel.get(trigger.destinationId) ?? null;
    return pluginLabel.get(trigger.destinationId) ?? null;
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.connectionTriggers(connectionId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.connectionDeliveries(connectionId) });
  };

  const create = useMutation({
    mutationFn: (input: Parameters<typeof toolsApi.createConnectionTrigger>[1]) =>
      toolsApi.createConnectionTrigger(connectionId, input),
    onSuccess: () => {
      invalidate();
      setCreateOpen(false);
      pushToast({ title: "Trigger added", tone: "success" });
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't add trigger",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      toolsApi.updateConnectionTrigger(connectionId, id, { enabled }),
    onSuccess: () => invalidate(),
    onError: (error) =>
      pushToast({
        title: "Couldn't update trigger",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => toolsApi.deleteConnectionTrigger(connectionId, id),
    onSuccess: () => {
      invalidate();
      setPendingDelete(null);
      pushToast({ title: "Trigger removed", tone: "success" });
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't remove trigger",
        body: error instanceof Error ? error.message : "Please try again.",
        tone: "error",
      }),
  });

  if (triggersQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (triggersQuery.isError) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <p className="text-sm font-medium text-foreground">Couldn't load triggers</p>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {triggersQuery.error instanceof Error ? triggersQuery.error.message : "Something went wrong."}
        </p>
        <Button className="mt-4" size="sm" variant="outline" onClick={() => triggersQuery.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Triggers</h2>
          <p className="mt-0.5 max-w-xl text-sm text-muted-foreground">
            Route {appName}'s inbound webhooks to work inside Paperclip. Up to {TRIGGER_LIMIT} destinations per
            connection.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button size="sm" onClick={() => setCreateOpen(true)} disabled={atLimit}>
            <Plus className="h-3.5 w-3.5" /> Add trigger
          </Button>
          <p className="text-(length:--text-micro) text-muted-foreground">
            {triggers.length}/{TRIGGER_LIMIT} used
          </p>
        </div>
      </div>

      {atLimit && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Limit reached — a connection can route to at most {TRIGGER_LIMIT} destinations. Remove one to add another.
        </div>
      )}

      {triggers.length === 0 ? (
        <EmptyTriggers onAdd={() => setCreateOpen(true)} appName={appName} />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {triggers.map((trigger) => (
            <TriggerRow
              key={trigger.id}
              trigger={trigger}
              label={labelFor(trigger)}
              directoriesLoading={
                routinesQuery.isLoading || pluginsQuery.isLoading || issuesQuery.isLoading
              }
              onToggle={(enabled) => toggle.mutate({ id: trigger.id, enabled })}
              togglePending={toggle.isPending && toggle.variables?.id === trigger.id}
              onDelete={() => setPendingDelete(trigger)}
            />
          ))}
        </ul>
      )}

      <DeliverySection query={deliveriesQuery} />

      <CreateTriggerDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        appName={appName}
        pending={create.isPending}
        existing={triggers}
        routines={(routinesQuery.data ?? []).map((r) => ({ value: r.id, label: r.title }))}
        plugins={(pluginsQuery.data ?? []).map((p) => ({ value: p.id, label: p.pluginKey }))}
        issues={(issuesQuery.data ?? [])
          .filter((i) => i.assigneeAgentId)
          .map((i) => ({ value: i.id, label: `${i.identifier} · ${i.title}` }))}
        directoriesLoading={routinesQuery.isLoading || pluginsQuery.isLoading || issuesQuery.isLoading}
        onSubmit={(input) => create.mutate(input)}
      />

      <AlertDialog open={!!pendingDelete} onOpenChange={(next) => !next && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this trigger?</AlertDialogTitle>
            <AlertDialogDescription>
              Inbound webhooks will stop routing to this {pendingDelete ? KIND_META[pendingDelete.destinationType].noun : "destination"}. Deliveries already recorded are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (pendingDelete) remove.mutate(pendingDelete.id);
              }}
              disabled={remove.isPending}
            >
              {remove.isPending ? "Removing…" : "Remove trigger"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyTriggers({ onAdd, appName }: { onAdd: () => void; appName: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center">
      <Webhook className="mx-auto h-8 w-8 text-muted-foreground" />
      <p className="mt-3 text-base font-bold text-foreground">No triggers yet</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
        Add a trigger to route {appName}'s inbound webhooks to a routine, an issue wake, or a plugin worker.
      </p>
      <Button className="mt-4" size="sm" onClick={onAdd}>
        <Plus className="h-3.5 w-3.5" /> Add trigger
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trigger row
// ---------------------------------------------------------------------------

function TriggerRow({
  trigger,
  label,
  directoriesLoading,
  onToggle,
  togglePending,
  onDelete,
}: {
  trigger: ConnectionTriggerRecord;
  label: string | null;
  directoriesLoading: boolean;
  onToggle: (enabled: boolean) => void;
  togglePending: boolean;
  onDelete: () => void;
}) {
  const meta = KIND_META[trigger.destinationType];
  const Icon = meta.icon;
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
            {meta.label}
          </span>
          {!trigger.enabled && (
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-(length:--text-micro) font-medium text-muted-foreground">
              Paused
            </span>
          )}
        </div>
        <p className="mt-1 truncate text-sm font-medium text-foreground">
          {label ?? (directoriesLoading ? "Loading…" : meta.noun + " no longer exists")}
        </p>
        <p className="truncate font-mono text-(length:--text-micro) text-muted-foreground">{trigger.destinationId}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <ToggleSwitch
          checked={trigger.enabled}
          onCheckedChange={onToggle}
          disabled={togglePending}
          aria-label={trigger.enabled ? "Pause trigger" : "Enable trigger"}
        />
        <button
          type="button"
          onClick={onDelete}
          className="rounded-md p-1.5 text-muted-foreground outline-none hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive"
          aria-label="Remove trigger"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Delivery observability
// ---------------------------------------------------------------------------

type DeliveriesQuery = ReturnType<
  typeof useQuery<Awaited<ReturnType<typeof toolsApi.getConnectionTriggerDeliveries>>>
>;

const COUNT_TILES: Array<{
  key: "received" | "forwarded" | "delivered" | "failed" | "deadLetter";
  label: string;
  className: string;
}> = [
  { key: "received", label: "Received", className: "text-foreground" },
  { key: "forwarded", label: "Forwarded", className: "text-sky-600 dark:text-sky-400" },
  { key: "delivered", label: "Delivered", className: "text-emerald-600 dark:text-emerald-400" },
  { key: "failed", label: "Failed", className: "text-amber-600 dark:text-amber-400" },
  { key: "deadLetter", label: "Dead-letter", className: "text-destructive" },
];

function DeliverySection({ query }: { query: DeliveriesQuery }) {
  const summary = query.data?.summary;

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Deliveries</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Inbound webhooks this connection has received and forwarded to its triggers.
        </p>
      </div>

      {query.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : query.isError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <p className="text-sm font-medium text-foreground">Couldn't load deliveries</p>
          </div>
          <Button className="mt-3" size="sm" variant="outline" onClick={() => query.refetch()}>
            Try again
          </Button>
        </div>
      ) : summary && summary.counts.received === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Delivery data appears after this connection sees inbound activity.
        </div>
      ) : summary ? (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {COUNT_TILES.map((tile) => (
              <div key={tile.key} className="rounded-lg border border-border bg-card px-3 py-2.5">
                <dt className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
                  {tile.label}
                </dt>
                <dd className={cn("mt-0.5 text-xl font-semibold tabular-nums", tile.className)}>
                  {summary.counts[tile.key]}
                </dd>
              </div>
            ))}
          </dl>

          {summary.lastError && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <p className="text-sm font-medium text-foreground">Last error</p>
              </div>
              <p className="mt-1 break-words text-sm text-foreground">{summary.lastError.message}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                delivery {summary.lastError.deliveryId} · {relativeTime(summary.lastError.at)}
              </p>
            </div>
          )}

          {summary.deadLetters.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Dead-letter queue ({summary.deadLetters.length})
              </h4>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-destructive/30">
                {summary.deadLetters.map((row) => (
                  <li key={row.id} className="bg-destructive/[0.03] px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{row.providerSlug}</span>
                      <span className="shrink-0 text-(length:--text-micro) text-muted-foreground">
                        {row.attempt} attempts · {relativeTime(row.receivedAt)}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-(length:--text-micro) text-muted-foreground">
                      {row.deliveryId}
                    </p>
                    {row.lastError && (
                      <p className="mt-1 break-words text-xs text-destructive">{row.lastError}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

type Option = { value: string; label: string };

function CreateTriggerDialog({
  open,
  onOpenChange,
  appName,
  pending,
  existing,
  routines,
  plugins,
  issues,
  directoriesLoading,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appName: string;
  pending: boolean;
  existing: ConnectionTriggerRecord[];
  routines: Option[];
  plugins: Option[];
  issues: Option[];
  directoriesLoading: boolean;
  onSubmit: (input: {
    destinationType: ConnectionTriggerDestinationType;
    destinationId: string;
    config?: Record<string, unknown>;
  }) => void;
}) {
  const [kind, setKind] = useState<ConnectionTriggerDestinationType>("routine");
  const [destinationId, setDestinationId] = useState("");
  const [endpointKey, setEndpointKey] = useState("");

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setKind("routine");
      setDestinationId("");
      setEndpointKey("");
    }
  }, [open]);

  const optionsForKind: Record<ConnectionTriggerDestinationType, Option[]> = {
    routine: routines,
    issue_wake: issues,
    plugin_worker: plugins,
  };
  const options = optionsForKind[kind];
  // A destination already routed by another trigger can't be routed twice
  // (server enforces a uniqueness constraint) — hide those so it never 500s.
  const takenIds = new Set(
    existing.filter((t) => t.destinationType === kind).map((t) => t.destinationId),
  );
  const availableOptions = options.filter((option) => !takenIds.has(option.value));

  const submit = () => {
    if (!destinationId) return;
    const config = kind === "plugin_worker" && endpointKey.trim() ? { endpointKey: endpointKey.trim() } : undefined;
    onSubmit({ destinationType: kind, destinationId, config });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a trigger</DialogTitle>
          <DialogDescription>
            Choose where {appName}'s inbound webhooks should go.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Destination kind</Label>
            <RadioCardGroup
              ariaLabel="Destination kind"
              value={kind}
              onValueChange={(next) => {
                setKind(next as ConnectionTriggerDestinationType);
                setDestinationId("");
              }}
              options={KIND_ORDER.map((value) => ({
                value,
                title: KIND_META[value].label,
                description: KIND_META[value].blurb,
              }))}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="trigger-destination">{KIND_META[kind].label} to route to</Label>
            {directoriesLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : availableOptions.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
                {options.length === 0
                  ? `No ${KIND_META[kind].noun}s are available to route to yet.`
                  : `Every ${KIND_META[kind].noun} is already wired to a trigger.`}
                {kind === "issue_wake" && options.length === 0
                  ? " Only issues with an assigned agent can be woken."
                  : ""}
              </p>
            ) : (
              <Select value={destinationId} onValueChange={setDestinationId}>
                <SelectTrigger id="trigger-destination">
                  <SelectValue placeholder={`Select a ${KIND_META[kind].noun}…`} />
                </SelectTrigger>
                <SelectContent>
                  {availableOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {kind === "plugin_worker" && (
            <div className="space-y-2">
              <Label htmlFor="trigger-endpoint-key">Endpoint key (optional)</Label>
              <Input
                id="trigger-endpoint-key"
                placeholder="connection-relay"
                value={endpointKey}
                onChange={(event) => setEndpointKey(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Passed to the plugin worker's webhook handler. Leave blank for the default.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !destinationId}>
            {pending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Adding…
              </>
            ) : (
              "Add trigger"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
