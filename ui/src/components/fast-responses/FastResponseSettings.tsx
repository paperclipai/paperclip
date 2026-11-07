import { useTranslation , t } from "@/i18n";
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
  const { t } = useTranslation("connections");
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
    <section className="max-w-2xl space-y-4" aria-label={t("fast_response_5f34643")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("fast_response_d220c56")}</h2>
        <Link
          to="/activity/costs?tab=fast-responses"
          className="text-sm underline underline-offset-4"
        >{t("view_usage_d86babc")}</Link>
      </div>
      <p className="text-sm text-muted-foreground">{t("send_a_short_acknowledgement_while_your_agent_c24b313")}</p>
      <ConnectionChoiceList
        selectedId={draft.grantId ?? undefined}
        disabled={saving || testing}
        choices={choices.map((c) => ({
          id: c.grantId,
          name: c.name,
          description:
            c.status === "connected" ? t("final-components-b:fast-responses.FastResponseSettings.Connected_229655") : t("final-components-b:fast-responses.FastResponseSettings.Needs_attention_c1ebc7"),
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
        <p className="text-sm text-muted-foreground">{t("add_a_shared_api_connection_in_apps_8117287")}</p>
      )}
      <div className="flex items-center gap-3">
        {onAdd && (
          <Button variant="outline" size="sm" onClick={onAdd}>{t("add_connection_e482d7c")}</Button>
        )}
        <Link to="/apps" className="text-sm underline underline-offset-4">{t("manage_connections_6cd2ce3")}</Link>
      </div>
      {draft.connectionId && (
        <fieldset disabled={saving || testing} className="space-y-4">
          {!selected && (
            <p role="status" className="text-sm text-muted-foreground">{t("the_saved_connection_is_unavailable_disable_fast_68c6ba2")}</p>
          )}
          <div className="space-y-2">
            <label
              htmlFor={`${modelListId}-input`}
              className="text-sm font-medium"
            >{t("model_b32422f")}</label>
            <Input
              id={`${modelListId}-input`}
              list={modelListId}
              value={draft.model ?? ""}
              placeholder={t("choose_or_enter_a_model_id_0e0ebf5")}
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
            label={t("enable_fast_responses_1968d1f")}
            checked={draft.enabled}
            onChange={(enabled) => setDraft((d) => ({ ...d, enabled }))}
          />
          <div className="space-y-2">
            <ToggleField
              label={t("allow_company_sponsored_fast_responses_1d63165")}
              checked={draft.allowSponsored}
              onChange={(allowSponsored) =>
                setDraft((d) => ({ ...d, allowSponsored }))
              }
            />
            <p className="text-xs text-muted-foreground">{t("covers_accepted_external_messages_from_people_without_806bd61")}</p>
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
            <p className="text-xs text-muted-foreground">{t("seconds_input_output_tokens_usage_recorded_in_77b3317", { value: (result.durationMs / 1000).toFixed(2), value2: result.usage.inputTokens ?? "—", value3: result.usage.outputTokens ?? "—" })}</p>
          </div>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {result.reason === "timeout"
              ? t("the_model_did_not_respond_within_three_72b56be")
              : t("could_not_generate_a_response_check_the_8433b30")}
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
            {testing ? t("testing_95c4564") : t("test_response_6090aad")}
          </Button>
          <p className="text-xs text-muted-foreground">
            {dirty
              ? t("save_changes_before_testing_041f387")
              : t("runs_a_small_sample_with_an_api_10de050")}
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
            {saving ? t("saving_56a2285") : t("save_fast_response_2bffe1e")}
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
  const { t } = useTranslation("connections");
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
      <p className="text-sm text-muted-foreground">{t("loading_fast_response_a7f594a")}</p>
    );
  if (query.error)
    return (
      <div role="alert">
        <p className="text-sm text-destructive">{t("could_not_load_fast_response_settings_53b21f3")}</p>
        <Button variant="outline" onClick={() => void query.refetch()}>{t("try_again_d15968e")}</Button>
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
            ? t("final-components-b:fast-responses.FastResponseSettings.Could_not_load_models_Enter_a_model_ID_or_retry_later_2df647")
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
            <DialogTitle>{t("add_a_fast_response_connection_655a70a")}</DialogTitle>
            <DialogDescription>{t("use_a_shared_api_connection_for_short_6f53d02")}</DialogDescription>
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
                get description() { return t("final-components-b:fast-responses.FastResponseSettings.Shared_API_connection_2f85b7"); },
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
