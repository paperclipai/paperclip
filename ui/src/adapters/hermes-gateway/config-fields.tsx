import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret } from "@paperclipai/shared";
import type { AdapterConfigFieldsProps } from "../types";
import { useCompany } from "../../context/CompanyContext";
import { secretsApi } from "../../api/secrets";
import { queryKeys } from "../../lib/queryKeys";
import {
  Field,
  DraftInput,
  DraftNumberInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

type SecretRefBinding = { type: "secret_ref"; secretId: string; version: "latest" | number };

function isSecretRef(value: unknown): value is SecretRefBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "secretId" in value &&
    (value as { type?: unknown }).type === "secret_ref" &&
    typeof (value as { secretId?: unknown }).secretId === "string"
  );
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readSecretRef(
  value: unknown,
): { mode: "plain" | "secret"; plainValue: string; secretId: string } {
  if (isSecretRef(value)) {
    return { mode: "secret", plainValue: "", secretId: value.secretId };
  }
  return { mode: "plain", plainValue: readString(value), secretId: "" };
}

function defaultSecretName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function SecretValueField({
  label,
  value,
  onChange,
  secrets,
  onCreateSecret,
}: {
  label: string;
  value: unknown;
  onChange: (next: string | SecretRefBinding | undefined) => void;
  secrets: CompanySecret[];
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
}) {
  const current = useMemo(() => readSecretRef(value), [value]);
  const [error, setError] = useState<string | null>(null);

  async function sealValue() {
    if (!current.plainValue.trim()) return;
    const suggested = defaultSecretName(label) || "secret";
    const name = window.prompt("Secret name", suggested)?.trim();
    if (!name) return;

    try {
      setError(null);
      const created = await onCreateSecret(name, current.plainValue);
      onChange({ type: "secret_ref", secretId: created.id, version: "latest" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create secret");
    }
  }

  return (
    <Field label={label}>
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <select
            className={inputClass + " max-w-[120px] bg-background"}
            value={current.mode}
            onChange={(event) => {
              const nextMode = event.target.value === "secret" ? "secret" : "plain";
              if (nextMode === "secret") {
                onChange(
                  current.secretId
                    ? { type: "secret_ref", secretId: current.secretId, version: "latest" }
                    : undefined,
                );
              } else {
                onChange(current.plainValue || undefined);
              }
            }}
          >
            <option value="plain">Plain</option>
            <option value="secret">Secret</option>
          </select>

          {current.mode === "secret" ? (
            <select
              className={inputClass + " flex-1 bg-background"}
              value={current.secretId}
              onChange={(event) => {
                const secretId = event.target.value;
                onChange(secretId ? { type: "secret_ref", secretId, version: "latest" } : undefined);
              }}
            >
              <option value="">Select secret...</option>
              {secrets.map((secret) => (
                <option key={secret.id} value={secret.id}>
                  {secret.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={inputClass + " flex-1"}
              placeholder="Bearer token"
              value={current.plainValue}
              onChange={(event) => onChange(event.target.value || undefined)}
            />
          )}

          {current.mode === "plain" && (
            <button
              type="button"
              className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
              onClick={() => void sealValue()}
              disabled={!current.plainValue.trim()}
              title="Store value as secret and replace with reference"
            >
              Seal
            </button>
          )}
        </div>
        {error && <p className="text-[11px] text-destructive">{error}</p>}
      </div>
    </Field>
  );
}

export function HermesGatewayConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const { data: secrets = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => {
      if (!selectedCompanyId) throw new Error("Select a company to create secrets");
      return secretsApi.create(selectedCompanyId, input);
    },
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
    },
  });

  const currentUrl = isCreate
    ? values!.adapterSchemaValues?.url ?? values!.url ?? ""
    : eff("adapterConfig", "url", String(config.url ?? ""));
  const currentModel = isCreate
    ? values!.adapterSchemaValues?.model ?? ""
    : eff("adapterConfig", "model", String(config.model ?? ""));
  const currentApiKey = isCreate
    ? values!.adapterSchemaValues?.apiKey
    : eff("adapterConfig", "apiKey", config.apiKey);
  const currentTimeout = isCreate
    ? Number(values!.adapterSchemaValues?.timeoutSec ?? 300)
    : Number(eff("adapterConfig", "timeoutSec", Number(config.timeoutSec ?? 300)));
  const currentApiMode = isCreate
    ? String(values!.adapterSchemaValues?.apiMode ?? "chat_completions")
    : String(eff("adapterConfig", "apiMode", String(config.apiMode ?? "chat_completions")));
  const currentSessionStrategy = isCreate
    ? String(values!.adapterSchemaValues?.sessionKeyStrategy ?? "issue")
    : String(eff("adapterConfig", "sessionKeyStrategy", String(config.sessionKeyStrategy ?? "issue")));
  const currentSessionKey = isCreate
    ? String(values!.adapterSchemaValues?.sessionKey ?? "")
    : String(eff("adapterConfig", "sessionKey", String(config.sessionKey ?? "")));
  const currentStoreResponses = isCreate
    ? values!.adapterSchemaValues?.storeResponses !== false
    : Boolean(eff("adapterConfig", "storeResponses", config.storeResponses ?? true));

  const setCreateField = (key: string, value: unknown) => {
    set?.({
      adapterSchemaValues: {
        ...(values?.adapterSchemaValues ?? {}),
        [key]: value,
      },
    });
  };

  const setEditField = (key: string, value: unknown) => {
    mark("adapterConfig", key, value);
  };

  const commitField = (key: string, value: unknown) => {
    if (isCreate) {
      setCreateField(key, value);
    } else {
      setEditField(key, value);
    }
  };

  return (
    <>
      <Field label="Hermes API URL">
        <DraftInput
          value={String(currentUrl)}
          onCommit={(value) => commitField("url", value || undefined)}
          immediate
          className={inputClass}
          placeholder="https://hermes-gateway.example.internal/v1/chat/completions"
        />
      </Field>

      <Field label="Model">
        <DraftInput
          value={String(currentModel)}
          onCommit={(value) => commitField("model", value || undefined)}
          immediate
          className={inputClass}
          placeholder="xiaomi/mimo-v2.5-pro"
        />
      </Field>

      <SecretValueField
        label="API key"
        value={currentApiKey}
        secrets={secrets}
        onCreateSecret={async (name, value) => createSecret.mutateAsync({ name, value })}
        onChange={(next) => commitField("apiKey", next)}
      />

      <Field label="Timeout (sec)">
        <DraftNumberInput
          value={Number.isFinite(currentTimeout) ? currentTimeout : 300}
          onCommit={(value) => commitField("timeoutSec", value > 0 ? value : undefined)}
          immediate
          className={inputClass}
        />
      </Field>

      <Field label="API mode">
        <select
          className={inputClass + " bg-background"}
          value={currentApiMode}
          onChange={(event) => commitField("apiMode", event.target.value)}
        >
          <option value="chat_completions">Chat Completions</option>
          <option value="responses">Responses</option>
        </select>
      </Field>

      <Field label="Session strategy">
        <select
          className={inputClass + " bg-background"}
          value={currentSessionStrategy}
          onChange={(event) => commitField("sessionKeyStrategy", event.target.value)}
        >
          <option value="issue">Per issue</option>
          <option value="run">Per run</option>
          <option value="fixed">Fixed</option>
        </select>
      </Field>

      {currentSessionStrategy === "fixed" && (
        <Field label="Fixed session key">
          <DraftInput
            value={String(currentSessionKey)}
            onCommit={(value) => commitField("sessionKey", value || undefined)}
            immediate
            className={inputClass}
            placeholder="paperclip"
          />
        </Field>
      )}

      {currentApiMode === "responses" && (
        <Field label="Store responses">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={currentStoreResponses}
              onChange={(event) => commitField("storeResponses", event.target.checked)}
            />
            <span className="text-muted-foreground">
              Keep Hermes server-side conversation history for this conversation key
            </span>
          </label>
        </Field>
      )}
    </>
  );
}
