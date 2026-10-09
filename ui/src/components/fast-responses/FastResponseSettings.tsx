import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FAST_RESPONSE_DEFAULT_MODEL,
  type FastResponseSettings,
  type AiManagedConnectionSummary,
  type FastResponseTestResult,
  type UpdateFastResponse,
  type AiProvider,
} from "@paperclipai/shared";
import { fastResponsesApi } from "@/api/fast-responses";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleField } from "@/components/agent-config-primitives";
import { ConnectionChoiceList } from "@/features/connections/ConnectionChoiceList";
import { AppLogo } from "@/pages/apps/AppLogo";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Link } from "@/lib/router";

const editable = (s: FastResponseSettings): UpdateFastResponse => ({
  enabled: s.enabled,
  connectionId: s.connectionId,
  grantId: s.grantId,
  model: s.model,
  allowSponsored: s.allowSponsored,
});

export function FastResponseSettingsView({
  settings,
  choices,
  models = [],
  saving,
  testing,
  error,
  result,
  newlyConnectedId,
  onSave,
  onTest,
  onConnectionChange,
  onAdd,
}: {
  settings: FastResponseSettings;
  choices: AiManagedConnectionSummary[];
  models?: Array<{ id: string; label?: string }>;
  newlyConnectedId?: string | null;
  saving?: boolean;
  testing?: boolean;
  error?: string | null;
  result?: FastResponseTestResult | null;
  onAdd?: () => void;
  onSave: (value: UpdateFastResponse) => void;
  onTest: () => void;
  onConnectionChange?: (id: string | null) => void;
}) {
  const [draft, setDraft] = useState<UpdateFastResponse>(() =>
    editable(settings),
  );
  const modelListId = useId();
  const revision = JSON.stringify(editable(settings));
  useEffect(() => {
    setDraft(editable(settings));
    onConnectionChange?.(settings.connectionId);
  }, [revision]);
  const appliedConnection = useRef<string | null>(null);
  useEffect(() => {
    if (!newlyConnectedId) {
      appliedConnection.current = null;
      return;
    }
    if (appliedConnection.current === newlyConnectedId) return;
    const connection = choices.find((row) => row.id === newlyConnectedId);
    if (!connection) return;
    appliedConnection.current = newlyConnectedId;
    setDraft((value) => ({
      ...value,
      connectionId: connection.id,
      grantId: connection.grantId,
      model:
        connection.provider === "openrouter" ||
        connection.routing?.kind === "openrouter"
          ? FAST_RESPONSE_DEFAULT_MODEL
          : (connection.routing?.models[0]?.id ?? null),
      enabled: value.connectionId ? value.enabled : true,
    }));
    onConnectionChange?.(connection.id);
  }, [newlyConnectedId, choices, onConnectionChange]);
  const selected = choices.find((c) => c.grantId === draft.grantId);
  const dirty =
    draft.enabled !== settings.enabled ||
    draft.grantId !== settings.grantId ||
    draft.model !== settings.model ||
    draft.allowSponsored !== settings.allowSponsored;
  return (
    <section className="max-w-2xl space-y-4" aria-label="Fast response">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Fast response
        </h2>
        <Link
          to="/activity/costs?tab=fast-responses"
          className="text-sm underline underline-offset-4"
        >
          View usage
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        Send a short acknowledgement while your agent starts work. Usage is
        charged to the selected shared API connection.
      </p>
      <ConnectionChoiceList
        selectedId={draft.grantId ?? undefined}
        disabled={saving || testing}
        choices={choices.map((c) => ({
          id: c.grantId,
          name: c.name,
          description:
            c.status === "connected" ? "Connected" : "Needs attention",
          icon: <AppLogo name={c.provider} brandKey={c.provider} size={24} />,
        }))}
        onSelect={(grantId) => {
          const c = choices.find((c) => c.grantId === grantId)!;
          setDraft((d) => ({
            ...d,
            connectionId: c.id,
            grantId,
            model:
              c.provider === "openrouter" || c.routing?.kind === "openrouter"
                ? FAST_RESPONSE_DEFAULT_MODEL
                : (c.routing?.models[0]?.id ?? null),
            enabled: d.connectionId ? d.enabled : true,
          }));
          onConnectionChange?.(c.id);
        }}
      />
      {!choices.length && (
        <p className="text-sm text-muted-foreground">
          Add a shared API connection in Apps to get started.
        </p>
      )}
      <div className="flex items-center gap-3">
        {onAdd && (
          <Button variant="outline" size="sm" onClick={onAdd}>
            Add connection
          </Button>
        )}
        <Link to="/apps" className="text-sm underline underline-offset-4">
          Manage connections
        </Link>
      </div>
      {draft.connectionId && (
        <fieldset disabled={saving || testing} className="space-y-4">
          {!selected && (
            <p role="status" className="text-sm text-muted-foreground">
              The saved connection is unavailable. Disable fast responses or
              choose another connection.
            </p>
          )}
          <div className="space-y-2">
            <label
              htmlFor={`${modelListId}-input`}
              className="text-sm font-medium"
            >
              Model
            </label>
            <Input
              id={`${modelListId}-input`}
              list={modelListId}
              value={draft.model ?? ""}
              placeholder="Choose or enter a model ID"
              onChange={(e) =>
                setDraft((d) => ({ ...d, model: e.target.value || null }))
              }
            />
            <datalist id={modelListId}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label ?? m.id}
                </option>
              ))}
            </datalist>
          </div>
          <ToggleField
            label="Enable fast responses"
            checked={draft.enabled}
            onChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
          />
          <div className="space-y-2">
            <ToggleField
              label="Allow company-sponsored fast responses"
              checked={draft.allowSponsored}
              onChange={(allowSponsored) =>
                setDraft((d) => ({ ...d, allowSponsored }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Covers accepted external messages from people without a linked
              Paperclip account.
            </p>
          </div>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!dirty &&
        result &&
        (result.status === "succeeded" ? (
          <div role="status" className="space-y-2 text-sm">
            <p>{result.text}</p>
            <p className="text-xs text-muted-foreground">
              {(result.durationMs / 1000).toFixed(2)} seconds ·{" "}
              {result.usage.inputTokens ?? "—"} input /{" "}
              {result.usage.outputTokens ?? "—"} output tokens · Usage recorded
              in Costs.
            </p>
          </div>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {result.reason === "timeout"
              ? "The model did not respond within three seconds. Try a faster model."
              : "Could not generate a response. Check the connection and model, then try again."}
          </p>
        ))}
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <Button
            variant="outline"
            size="sm"
            onClick={onTest}
            disabled={dirty || !settings.enabled || saving || testing}
          >
            {testing ? "Testing…" : "Test response"}
          </Button>
          <p className="text-xs text-muted-foreground">
            {dirty
              ? "Save changes before testing."
              : "Runs a small sample with an API charge."}
          </p>
        </div>
        {dirty && (
          <Button
            disabled={
              saving ||
              testing ||
              (draft.enabled &&
                (!draft.model || selected?.status !== "connected"))
            }
            onClick={() => onSave(draft)}
          >
            {saving ? "Saving…" : "Save fast response"}
          </Button>
        )}
      </div>
    </section>
  );
}
export function FastResponseSettingsSection({
  companyId,
}: {
  companyId: string;
}) {
  const client = useQueryClient(),
    key = ["fast-response", companyId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => fastResponsesApi.settings(companyId),
  });
  const [newlyConnectedId, setNewlyConnectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const models = useQuery({
    queryKey: ["fast-response-models", companyId, connectionId],
    queryFn: () => fastResponsesApi.models(companyId, connectionId!),
    enabled: Boolean(connectionId),
  });
  const settingsRevision = JSON.stringify(
    query.data?.settings ?? { companyId },
  );
  const test = useMutation({
    mutationFn: (_revision: string) => fastResponsesApi.test(companyId),
    onSettled: () => {
      void client.invalidateQueries({
        queryKey: ["fast-response-history", companyId],
      });
      void client.invalidateQueries({
        predicate: (q) => String(q.queryKey[0]).includes("cost"),
      });
    },
  });
  const resetTest = test.reset;
  useEffect(() => {
    resetTest();
  }, [settingsRevision, resetTest]);
  const save = useMutation({
    mutationFn: (settings: UpdateFastResponse) =>
      fastResponsesApi.update(companyId, settings),
    onSuccess: (settings) => {
      test.reset();
      client.setQueryData(key, { ...query.data, settings });
    },
  });
  if (query.isPending)
    return (
      <p className="text-sm text-muted-foreground">Loading fast response…</p>
    );
  if (query.error)
    return (
      <div role="alert">
        <p className="text-sm text-destructive">
          Could not load fast response settings.
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    );
  if (!query.data?.canManage || !query.data.settings) return null;
  return (
    <>
      <FastResponseSettingsView
        key={companyId}
        newlyConnectedId={newlyConnectedId}
        settings={query.data.settings}
        choices={query.data.choices}
        models={models.data}
        saving={save.isPending}
        testing={test.isPending}
        error={
          save.error?.message ??
          test.error?.message ??
          (models.error
            ? "Could not load models. Enter a model ID or retry later."
            : null)
        }
        result={test.variables === settingsRevision ? test.data : null}
        onConnectionChange={setConnectionId}
        onSave={(v) => save.mutate(v)}
        onTest={() => test.mutate(settingsRevision)}
        onAdd={() => {
          setProvider(null);
          setAdding(true);
        }}
      />
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-2xl max-h-(--sz-85vh) overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add a fast response connection</DialogTitle>
            <DialogDescription>
              Use a shared API connection for short acknowledgements.
            </DialogDescription>
          </DialogHeader>
          {provider ? (
            <ConnectionSetupFlow
              host="dialog"
              serviceSlug={provider}
              forceNewConnection
              aiConnection={{ provider, method: "api_key", mode: "shared" }}
              requiredAiOwnership="shared"
              onCancel={() => setAdding(false)}
              onComplete={async (result) => {
                const refreshed = await query.refetch();
                if (
                  "connectionId" in result &&
                  result.connectionId &&
                  refreshed.data?.choices.some(
                    (row) => row.id === result.connectionId,
                  )
                )
                  setNewlyConnectedId(result.connectionId);
                setAdding(false);
              }}
            />
          ) : (
            <ConnectionChoiceList
              choices={[
                "openrouter",
                "openai",
                "anthropic",
                "google",
                "xai",
              ].map((id) => ({
                id,
                description: "Shared API connection",
                name:
                  id === "openrouter"
                    ? "OpenRouter"
                    : id === "openai"
                      ? "OpenAI"
                      : id === "xai"
                        ? "xAI"
                        : id === "google"
                          ? "Google"
                          : "Anthropic",
                icon: <AppLogo name={id} brandKey={id} size={24} />,
              }))}
              onSelect={(id) => setProvider(id as AiProvider)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
