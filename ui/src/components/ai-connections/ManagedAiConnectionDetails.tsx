import { useEffect, useRef, useState } from "react";
import { heartbeatsApi } from "@/api/heartbeats";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import { agentsApi, type AdapterModel } from "@/api/agents";
import { aiConnectionsApi } from "@/api/ai-connections";
import { toolsApi } from "@/api/tools";
import { useNavigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import {
  IMPORT_READ_GUIDANCE,
  LOCAL_CLAUDE_SETTINGS_PATH,
  resolveImportModel,
} from "@/lib/claude-config-import";
import type { LocalClaudeConfigReadResult, ToolConnection, AiConnectionMetadata } from "@paperclipai/shared";
import { AiConnectionAccountControls } from "./AiConnectionAccountControls";
import { AiConnectionUsagePanel } from "./AiConnectionUsagePanel";
import { aiMethodLabel } from "./model";
import { Loader2, RefreshCw } from "lucide-react";

/**
 * The endpoint a connection sends its key to, named wherever a connection is
 * listed or opened (PRODUCT #30): two Anthropic connections in one company can
 * differ in nothing else, so the row has to say which one it is. Only an import
 * sets an endpoint — every other connection uses the provider's official API.
 *
 * Shared with the agent-configuration chooser (`AiConnectionPicker`) so the two
 * cannot drift: a row that named its endpoint one way and the picker that lists
 * the same connection another would leave a reader comparing descriptions
 * instead of endpoints.
 */
export function aiEndpointLabel(baseUrl: string | undefined) {
  return baseUrl ? `Custom endpoint · ${baseUrl}` : "Official endpoint";
}

/** The stored metadata keeps the endpoint next to the provider, never in the UI. */
function managedAiEndpoint(connection: ToolConnection): string | undefined {
  const metadata = connection.config?.ai as { baseUrl?: string } | undefined;
  return typeof metadata?.baseUrl === "string" ? metadata.baseUrl : undefined;
}

/**
 * The value that turns the card's model row from a list into a free-text field.
 * A gateway can serve a model no curated list carries, and the field is the same
 * one it is everywhere else — not stricter for having arrived by an import
 * (PRODUCT #19).
 */
const IMPORT_MODEL_OTHER = "__other__";

/**
 * What a refused re-import says.
 *
 * The route's own message is the better copy whenever there is one: a gateway
 * rejection names the two credential variables and the file to edit, and a
 * server refusal names the reason it refused. This only supplies a sentence for
 * a failure that never got an answer at all.
 */
function reimportErrorMessage(error: unknown): string {
  return error instanceof ApiError && error.message
    ? error.message
    : "Could not reach the gateway. Check the address in this machine's Claude settings and try again.";
}

/**
 * Where the re-import's read is.
 *
 * `reading` rather than `idle`, because opening the card *is* the read (PRODUCT
 * #9): every entry re-reads the file, so there is no state where the card is
 * open and nothing has been asked for yet.
 */
type ReimportReadState =
  | { status: "reading" }
  | { status: "ready"; result: Extract<LocalClaudeConfigReadResult, { status: "ok" }> }
  | {
      status: "unavailable";
      message: string;
      /** What to do about it, when the read did not already say. */
      guidance?: string;
    };

/**
 * The re-import card for one connection that carries its own endpoint.
 *
 * It reads the operator's settings file again, shows the same confirmation the
 * first import showed, and posts it back with this connection's id, so the route
 * reconnects the row that already exists rather than building a second one
 * beside it (PRODUCT #33). The account keeps its identity, its agent grants and
 * its default status, because a reconnect touches none of them (PRODUCT #34).
 *
 * The card survives a refusal with its values, because the fix is on the
 * gateway's side and costs one more press (PRODUCT #25); the route writes
 * nothing when the probe fails, so a failed re-import leaves the account exactly
 * as it was (PRODUCT #35).
 *
 * The key is here as a variable name and a mask and nothing else — the read does
 * not return the value, so there is nothing on this card to leak (PRODUCT #17,
 * #41).
 */
function ReimportClaudeConfigDialog({
  companyId,
  connectionId,
  connectionName,
  ownership,
  onClose,
}: {
  companyId: string;
  connectionId: string;
  connectionName: string;
  ownership: "personal" | "shared";
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [read, setRead] = useState<ReimportReadState>({ status: "reading" });
  const [model, setModel] = useState("");
  const [modelEditing, setModelEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** Bumped on unmount so a read that lands after the card closed is dropped. */
  const run = useRef(0);

  const readConfig = () => {
    const current = ++run.current;
    setRead({ status: "reading" });
    setError(null);
    void aiConnectionsApi.readLocalClaudeConfig(companyId)
      .then((result) => {
        if (current !== run.current) return;
        if (result.status === "ok") {
          setRead({ status: "ready", result });
          setModel(result.models.default);
          setModelEditing(false);
          return;
        }
        setRead({
          status: "unavailable",
          message: result.message,
          // Keyed by the reason the route reports rather than by its message:
          // the guidance has to name the missing variable and the file it
          // belongs in, and the route is free to reword its own copy.
          guidance: IMPORT_READ_GUIDANCE[result.reason],
        });
      })
      .catch((cause: unknown) => {
        if (current !== run.current) return;
        // A refusal is the route's own answer — an untrusted instance, a caller
        // who is not the operator — and it knows what it refused. Pointing at
        // the settings file on top of that would be guessing at a cause it did
        // not give.
        const refused = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
        setRead({
          status: "unavailable",
          message: reimportErrorMessage(cause),
          ...(refused ? {} : { guidance: IMPORT_READ_GUIDANCE.settings_unreadable }),
        });
      });
  };
  // Opening the card is the read, so it goes out on mount rather than on a
  // press: every entry re-reads the file, which may have been edited since the
  // last look (PRODUCT #9).
  useEffect(() => {
    readConfig();
    // A read that lands after the card has closed belongs to nobody, so the
    // close bumps the run and drops it.
    return () => { run.current++; };
  }, []);

  // The card's model row carries the imported tiers plus the same list every
  // other surface picks from, and only while the card is on screen.
  const importModels = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, "claude_local", null),
    queryFn: () => agentsApi.adapterModels(companyId, "claude_local"),
    enabled: read.status === "ready",
  });
  const modelOptions = (() => {
    if (read.status !== "ready") return [] as AdapterModel[];
    const options: AdapterModel[] = [];
    const seen = new Set<string>();
    const push = (id: string, label?: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      options.push({ id, label: label ?? id });
    };
    push(read.result.models.default);
    for (const alternative of read.result.models.alternatives) push(alternative);
    for (const entry of importModels.data ?? []) push(entry.id, entry.label);
    return options;
  })();

  const reimport = async () => {
    if (read.status !== "ready") return;
    setPending(true);
    setError(null);
    try {
      await aiConnectionsApi.importLocalClaudeConfig(companyId, {
        provider: "anthropic",
        method: "api_key",
        // A reconnect keeps the name it has: renaming an account is not what
        // re-importing its gateway does, and the route would ignore it anyway.
        name: connectionName,
        ownership,
        agentIds: [],
        allAgents: false,
        connectionId,
        baseUrl: read.result.baseUrl,
        keyVariable: read.result.keyVariable,
        model: resolveImportModel(model, read.result),
        confirm: {
          keyVariable: read.result.keyVariable,
          maskedKey: read.result.maskedKey,
          defaultModel: read.result.models.default,
          alternativeModels: read.result.models.alternatives,
        },
      });
      // Everything that reads this account — its row, its endpoint label, its
      // usage answer — is answered from the stored metadata again.
      await client.invalidateQueries({ queryKey: ["ai-connections", companyId] });
      onClose();
    } catch (cause) {
      setError(reimportErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) { run.current++; onClose(); } }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Re-import from this machine</DialogTitle>
          <DialogDescription>
            Reads {LOCAL_CLAUDE_SETTINGS_PATH} again and updates this account&rsquo;s endpoint, key and model tiers. Its agent access and default status stay as they are.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {read.status === "reading" && (
            <p role="status" className="flex min-h-(--sz-108px) items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Reading this machine&rsquo;s Claude config…
            </p>
          )}
          {read.status === "unavailable" && (
            <div className="flex flex-col gap-3">
              <p role="alert" className="text-sm text-destructive">{read.message}</p>
              {read.guidance && (
                <p className="text-(length:--text-micro) leading-relaxed text-muted-foreground">{read.guidance}</p>
              )}
            </div>
          )}
          {read.status === "ready" && (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-(length:--text-micro) text-muted-foreground">Gateway</span>
                {/* Plain, and plainly an address: the operator is being asked to
                    confirm where their key is about to be sent, and the protocol
                    is part of that answer (PRODUCT #17). */}
                <span className="font-mono text-xs break-all text-foreground">{read.result.baseUrl}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-(length:--text-micro) text-muted-foreground">Key</span>
                <span className="font-mono text-xs text-foreground">
                  {read.result.keyVariable} · {read.result.maskedKey}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-(length:--text-micro) text-muted-foreground">Model</span>
                {modelEditing ? (
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label="Model"
                      autoFocus
                      value={model}
                      placeholder="Model id"
                      onChange={(event) => setModel(event.target.value)}
                      className="h-8 rounded-md border-transparent bg-background text-xs shadow-none"
                    />
                    <Button variant="ghost" size="sm" className="h-8 shrink-0 px-2 text-xs" onClick={() => setModelEditing(false)}>
                      Use the list
                    </Button>
                  </div>
                ) : (
                  <Select value={model} onValueChange={(value) => {
                    if (value === IMPORT_MODEL_OTHER) {
                      setModelEditing(true);
                      return;
                    }
                    setModel(value);
                  }}>
                    <SelectTrigger aria-label="Model" className="h-8 w-full text-xs">
                      <SelectValue placeholder="Model" />
                    </SelectTrigger>
                    <SelectContent>
                      {modelOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
                      ))}
                      <SelectItem value={IMPORT_MODEL_OTHER}>Other…</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                {read.result.models.alternatives.length > 0 && (
                  <span className="text-(length:--text-micro) text-muted-foreground">
                    Also configured: {read.result.models.alternatives.join(", ")}
                  </span>
                )}
              </div>
              {/* A failed probe leaves the card standing with its values, because
                  the fix is on the gateway's side and only costs one more press
                  (PRODUCT #25). */}
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => { run.current++; onClose(); }} disabled={pending}>
            Cancel
          </Button>
          {read.status === "ready" ? (
            <Button onClick={() => void reimport()} disabled={pending || importModels.isPending}>
              {pending ? "Re-importing…" : "Re-import"}
            </Button>
          ) : (
            <Button variant="outline" onClick={readConfig} disabled={read.status === "reading"}>
              Read again
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ManagedAiConnectionRow({
  connection,
}: {
  connection: ToolConnection;
}) {
  const metadata = connection.config?.ai as AiConnectionMetadata | undefined;
  if (!metadata) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {metadata.routing ? metadata.routing.kind === "bedrock" ? `Bedrock · ${metadata.routing.region}` : metadata.routing.kind === "openrouter" ? "OpenRouter" : metadata.routing.baseUrl : aiMethodLabel(metadata.provider, metadata.method)} ·{" "}
      {connection.credentialPolicy === "per_user"
        ? "Personal"
        : "Company shared"}{" "}
      ·{" "}
      <span className="break-words">{aiEndpointLabel(managedAiEndpoint(connection))}</span>
    </p>
  );
}
export function ManagedAiConnectionDetails({
  connection,
}: {
  connection: ToolConnection;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [reimporting, setReimporting] = useState(false);
  const runs = useQuery({
    queryKey: ["ai-connection-active-runs", connection.id],
    queryFn: () =>
      aiConnectionsApi.activeRuns(connection.companyId, connection.id),
  });
  const accounts = useQuery({
    queryKey: ["ai-connections", connection.companyId],
    queryFn: () => aiConnectionsApi.list(connection.companyId),
  });
  const grants = useQuery({
    queryKey: ["ai-connection-grants", connection.id],
    queryFn: () => toolsApi.listConnectionGrants(connection.id),
  });
  const refresh = () => client.invalidateQueries();
  const makeDefault = useMutation({
    mutationFn: (id: string) =>
      aiConnectionsApi.setDefault(connection.companyId, id),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      toolsApi.revokeConnectionGrant(connection.id, id),
    onSuccess: refresh,
  });
  const stop = useMutation({
    mutationFn: (id: string) => heartbeatsApi.cancel(id),
    onSuccess: refresh,
  });
  const account = accounts.data?.connections.find(
    (a) => a.id === connection.id,
  );
  const grant = grants.data?.grants.find((g) => g.id === account?.grantId);
  const error =
    accounts.error ??
    grants.error ??
    makeDefault.error ??
    stop.error;
  if (error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {error.message}
      </p>
    );
  if (!account || !grant)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {accounts.isPending || grants.isPending
          ? "Loading AI account…"
          : "This account is not available to you."}
      </p>
    );
  return (
    <div className="space-y-4">
      {account.routing && <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Provider settings</summary><dl className="mt-4 grid grid-cols-2 gap-3 text-sm"><dt className="text-muted-foreground">Destination</dt><dd className="break-all">{account.routing.baseUrl ?? (account.routing.kind === "bedrock" ? account.routing.region : "OpenRouter")}</dd><dt className="text-muted-foreground">API format</dt><dd>{account.routing.kind === "openrouter" ? "Selected by harness" : account.routing.protocol}</dd><dt className="text-muted-foreground">Authentication</dt><dd>{account.routing.auth}</dd><dt className="text-muted-foreground">Models</dt><dd>{account.routing.models.map(m => m.label ?? m.id).join(", ") || "Enter a model ID on the agent"}</dd></dl></details>}
      <AiConnectionAccountControls
        account={account}
        grant={grant}
        currentUserId={accounts.data!.currentUserId}
        onMakeDefault={() => makeDefault.mutate(grant.id)}
        onRevoke={() => revoke.mutateAsync(grant.id).then(() => undefined)}
        revocationDetails={
          <div className="space-y-2">
            {runs.error && (
              <p role="alert">
                Could not load active runs. Retry before revoking.
              </p>
            )}
            {runs.data?.map((run) => (
              <div
                key={run.id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span>
                  {run.agentName} · {run.status}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={stop.isPending}
                  onClick={() => stop.mutate(run.id)}
                >
                  Stop run
                </Button>
              </div>
            ))}
          </div>
        }
        onReconnect={() =>
          navigate(
            `/apps/connect?source=${account.provider}&reconnect=${connection.id}&method=ai-${account.method}`,
          )
        }
      />
      {/* An imported connection runs on its own gateway, so the endpoint is
          stated next to the account it belongs to rather than left implied. */}
      <p className="break-words text-xs text-muted-foreground">
        {aiEndpointLabel(account.baseUrl)}
      </p>
      {/* Only an account that carries its own endpoint was ever imported, so only
          it can be re-read: for every other account the endpoint is the
          provider's official API, which this machine's settings never described
          (PRODUCT #33). */}
      {account.baseUrl && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => setReimporting(true)}>
            <RefreshCw className="size-4" aria-hidden />
            Re-import from this machine
          </Button>
          <p className="text-xs text-muted-foreground">
            Re-reads {LOCAL_CLAUDE_SETTINGS_PATH} and updates this account&rsquo;s endpoint, key and model tiers.
          </p>
        </div>
      )}
      {reimporting && (
        <ReimportClaudeConfigDialog
          companyId={connection.companyId}
          connectionId={connection.id}
          connectionName={connection.name}
          ownership={account.ownership}
          onClose={() => setReimporting(false)}
        />
      )}
      <AiConnectionUsagePanel key={`${account.id}:${account.grantId}:${account.status}`} account={account} />
    </div>
  );
}
