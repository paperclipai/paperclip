import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, NotebookPen, Search } from "lucide-react";
import { agentsApi } from "../api/agents";
import { memoryApi } from "../api/memory";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { Link } from "@/lib/router";
import { queryKeys } from "../lib/queryKeys";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";
import { cn, relativeTime } from "../lib/utils";

const LIMIT_OPTIONS = [25, 50, 100, 200];

function OperationStatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        statusBadge[status] ?? statusBadgeDefault,
      )}
    >
      {status}
    </span>
  );
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function MemoryPage() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [limit, setLimit] = useState(50);
  const [searchText, setSearchText] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [noteText, setNoteText] = useState("");
  const [savedNoteSlug, setSavedNoteSlug] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Memory" }]);
  }, [setBreadcrumbs]);

  const overviewQuery = useQuery({
    queryKey: queryKeys.memory.overview(selectedCompanyId!),
    queryFn: () => memoryApi.overview(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 10000,
  });
  const operationsQuery = useQuery({
    queryKey: queryKeys.memory.operations(selectedCompanyId!, limit),
    queryFn: () => memoryApi.listOperations(selectedCompanyId!, { limit }),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 10000,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const agentNameById = useMemo(
    () => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent.name])),
    [agentsQuery.data],
  );

  const toggleBindingMutation = useMutation({
    mutationFn: (enabled: boolean) => memoryApi.updateBinding(selectedCompanyId!, { enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.memory.overview(selectedCompanyId!) });
    },
  });
  const searchMutation = useMutation({
    mutationFn: (query: string) => memoryApi.query(selectedCompanyId!, { query }),
  });
  const noteMutation = useMutation({
    mutationFn: (data: { title?: string; text: string }) => memoryApi.note(selectedCompanyId!, data),
    onSuccess: (result) => {
      setSavedNoteSlug(result.slug);
      setNoteTitle("");
      setNoteText("");
      void queryClient.invalidateQueries({ queryKey: ["memory", selectedCompanyId, "operations"] });
    },
  });

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={Brain}
        message={companies.length === 0 ? "Create a company to view memory." : "Select a company to view memory."}
      />
    );
  }

  const overview = overviewQuery.data ?? null;
  const binding = overview?.binding ?? null;
  const bindingEnabled = Boolean(binding?.enabled);
  const memoryState: "on" | "off" | "unavailable" = !bindingEnabled
    ? "off"
    : overview?.providerAvailable
      ? "on"
      : "unavailable";
  const operations = operationsQuery.data?.items ?? [];
  const searchResult = searchMutation.data ?? null;
  const loadFailures = [
    overviewQuery.isError
      ? `Overview failed: ${errorMessage(overviewQuery.error, "Unable to load memory overview.")}`
      : null,
    operationsQuery.isError
      ? `Operations failed: ${errorMessage(operationsQuery.error, "Unable to load memory operations.")}`
      : null,
    agentsQuery.isError
      ? `Agents failed: ${errorMessage(agentsQuery.error, "Unable to load agent names.")}`
      : null,
  ].filter((message): message is string => message !== null);

  const handleSearch = () => {
    const query = searchText.trim();
    if (!query) return;
    searchMutation.mutate(query);
  };

  const handleSaveNote = () => {
    const text = noteText.trim();
    if (!text) return;
    setSavedNoteSlug(null);
    const title = noteTitle.trim();
    noteMutation.mutate(title ? { title, text } : { text });
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">Memory</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Gbrain recall layer: hydrate and capture audit trail, operator search, and notes.
        </p>
      </div>

      {loadFailures.length > 0 ? (
        <section className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-200">
          <div className="font-medium">Memory data failed to load</div>
          <div className="mt-1 space-y-1">
            {loadFailures.map((message) => (
              <div key={message}>{message}</div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium"><Brain className="h-4 w-4" /> Binding</div>
          <div className="flex items-center gap-3">
            <OperationStatusPill status={memoryState === "on" ? "ok" : memoryState === "unavailable" ? "warning" : "paused"} />
            <span className="text-xs text-muted-foreground">{memoryState}</span>
            <ToggleSwitch
              checked={bindingEnabled}
              onCheckedChange={(checked) => toggleBindingMutation.mutate(checked)}
              disabled={!binding || toggleBindingMutation.isPending}
              aria-label="Toggle memory binding"
            />
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <div className="text-[11px] uppercase text-muted-foreground">Provider</div>
            <div className="mt-1 truncate text-sm text-foreground">
              {binding ? `${binding.provider} (${binding.key})` : "no binding"}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-[11px] uppercase text-muted-foreground">Last hydrate</div>
            <div className="mt-1 truncate text-sm text-foreground">
              {overview?.stats.lastHydrateAt ? relativeTime(overview.stats.lastHydrateAt) : "never"}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-[11px] uppercase text-muted-foreground">Last capture</div>
            <div className="mt-1 truncate text-sm text-foreground">
              {overview?.stats.lastCaptureAt ? relativeTime(overview.stats.lastCaptureAt) : "never"}
            </div>
          </div>
          <div className="min-w-0">
            <div className="text-[11px] uppercase text-muted-foreground">Ops 24h</div>
            <div className="mt-1 truncate text-sm text-foreground">
              {overview ? `${overview.stats.opsLast24h} (${overview.stats.failuresLast24h} failed)` : "none"}
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm font-medium"><Search className="h-4 w-4" /> Search memory</div>
          <div className="mt-3 flex gap-2">
            <Input
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleSearch();
              }}
              placeholder="Search remembered context"
            />
            <Button onClick={handleSearch} disabled={!searchText.trim() || searchMutation.isPending}>
              {searchMutation.isPending ? "Searching…" : "Search"}
            </Button>
          </div>
          {searchMutation.isError ? (
            <div className="mt-3 text-sm text-red-600 dark:text-red-400">Search failed. Try again.</div>
          ) : null}
          {searchResult ? (
            <div className="mt-3 space-y-2">
              <div className="text-xs text-muted-foreground">
                {searchResult.snippets.length} snippet{searchResult.snippets.length === 1 ? "" : "s"} in {searchResult.latencyMs} ms
              </div>
              {searchResult.snippets.length === 0 ? (
                <div className="text-sm text-muted-foreground">No memory matched.</div>
              ) : searchResult.snippets.map((snippet) => (
                <div key={snippet.slug} className="rounded-md border border-border bg-background p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-sm font-medium">{snippet.title || snippet.slug}</div>
                    <span className="shrink-0 text-xs text-muted-foreground">{snippet.score.toFixed(3)}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{snippet.slug}</div>
                  <div className="mt-2 whitespace-pre-wrap text-sm text-foreground">{snippet.text}</div>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm font-medium"><NotebookPen className="h-4 w-4" /> Save note</div>
          <div className="mt-3 grid gap-2">
            <Input
              value={noteTitle}
              onChange={(event) => setNoteTitle(event.target.value)}
              placeholder="Title (optional)"
            />
            <Textarea
              value={noteText}
              onChange={(event) => setNoteText(event.target.value)}
              placeholder="Durable note for future runs"
            />
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 text-xs text-muted-foreground">
                {noteMutation.isError
                  ? <span className="text-red-600 dark:text-red-400">Saving note failed. Try again.</span>
                  : savedNoteSlug
                    ? `Saved as ${savedNoteSlug}`
                    : "Notes are written under the company memory namespace."}
              </div>
              <Button onClick={handleSaveNote} disabled={!noteText.trim() || noteMutation.isPending}>
                {noteMutation.isPending ? "Saving…" : "Save note"}
              </Button>
            </div>
          </div>
        </section>
      </div>

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="text-sm font-medium">Operations</div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Limit
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-sm outline-none"
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {LIMIT_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
        </div>
        {operationsQuery.isError ? (
          <div className="px-4 py-6 text-sm text-red-600 dark:text-red-400">
            Unable to load memory operations.
          </div>
        ) : operations.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            {operationsQuery.isLoading ? "Loading operations…" : "No memory operations recorded yet."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="border-b border-border text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Operation</th>
                  <th className="px-3 py-2 font-medium">Hook</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Agent</th>
                  <th className="px-3 py-2 font-medium">Run</th>
                  <th className="px-3 py-2 font-medium">Latency</th>
                  <th className="px-3 py-2 font-medium">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {operations.map((operation) => (
                  <tr key={operation.id}>
                    <td className="px-4 py-2 font-medium">{operation.operation}</td>
                    <td className="px-3 py-2 text-muted-foreground">{operation.hookKind ?? "—"}</td>
                    <td className="px-3 py-2"><OperationStatusPill status={operation.status} /></td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {operation.agentId
                        ? agentNameById.get(operation.agentId) ?? operation.agentId.slice(0, 8)
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {operation.heartbeatRunId ? (
                        operation.agentId ? (
                          <Link
                            to={`/agents/${operation.agentId}/runs/${operation.heartbeatRunId}`}
                            className="hover:text-foreground hover:underline"
                          >
                            {operation.heartbeatRunId.slice(0, 8)}
                          </Link>
                        ) : (
                          operation.heartbeatRunId.slice(0, 8)
                        )
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {operation.usageJson?.latencyMs != null ? `${operation.usageJson.latencyMs} ms` : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{relativeTime(operation.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
