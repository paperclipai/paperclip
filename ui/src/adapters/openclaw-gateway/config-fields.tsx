import { useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";
import {
  PayloadTemplateJsonField,
  RuntimeServicesJsonField,
} from "../runtime-json-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function HeadersJsonTextarea({
  isCreate,
  createDraft,
  onCreateDraftChange,
  editStringified,
  onEditCommit,
  inputClass,
}: {
  isCreate: boolean;
  createDraft: string;
  onCreateDraftChange: (next: string) => void;
  editStringified: string;
  onEditCommit: (next: string) => void;
  inputClass: string;
}) {
  useTranslation();
  const [editDraft, setEditDraft] = useState<string>(editStringified);
  const [lastSyncedFromConfig, setLastSyncedFromConfig] = useState<string>(editStringified);
  useEffect(() => {
    if (isCreate) return;
    if (editStringified !== lastSyncedFromConfig) {
      setEditDraft(editStringified);
      setLastSyncedFromConfig(editStringified);
    }
  }, [editStringified, isCreate, lastSyncedFromConfig]);
  const value = isCreate ? createDraft : editDraft;
  return (
    <textarea
      value={value}
      onChange={(e) => {
        const next = e.target.value;
        if (isCreate) {
          onCreateDraftChange(next);
        } else {
          setEditDraft(next);
          onEditCommit(next);
        }
      }}
      rows={3}
      className={inputClass}
      placeholder='{"x-custom-header": "value"}'
    />
  );
}

function SecretField({
  label,
  value,
  onCommit,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
}) {
  useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label}>
      <div className="relative">
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        >
          {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <DraftInput
          value={value}
          onCommit={onCommit}
          immediate
          type={visible ? "text" : "password"}
          className={inputClass + " pl-8"}
          placeholder={placeholder}
        />
      </div>
    </Field>
  );
}

function parseScopes(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").join(", ");
  }
  return typeof value === "string" ? value : "";
}

export function OpenClawGatewayConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const { t } = useTranslation();
  const configuredHeaders =
    config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)
      ? (config.headers as Record<string, unknown>)
      : {};
  const effectiveHeaders =
    (eff("adapterConfig", "headers", configuredHeaders) as Record<string, unknown>) ?? {};

  const effectiveGatewayToken = typeof effectiveHeaders["x-openclaw-token"] === "string"
    ? String(effectiveHeaders["x-openclaw-token"])
    : typeof effectiveHeaders["x-openclaw-auth"] === "string"
      ? String(effectiveHeaders["x-openclaw-auth"])
      : "";

  const commitGatewayToken = (rawValue: string) => {
    const nextValue = rawValue.trim();
    const nextHeaders: Record<string, unknown> = { ...effectiveHeaders };
    if (nextValue) {
      nextHeaders["x-openclaw-token"] = nextValue;
      delete nextHeaders["x-openclaw-auth"];
    } else {
      delete nextHeaders["x-openclaw-token"];
      delete nextHeaders["x-openclaw-auth"];
    }
    mark("adapterConfig", "headers", Object.keys(nextHeaders).length > 0 ? nextHeaders : undefined);
  };

  const sessionStrategy = eff(
    "adapterConfig",
    "sessionKeyStrategy",
    String(config.sessionKeyStrategy ?? "fixed"),
  );

  return (
    <>
      <Field label={t("onboarding.wizard.model.gatewayUrl")} hint={help.webhookUrl}>
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "url", String(config.url ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "url", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="ws://127.0.0.1:18789"
        />
      </Field>

      <PayloadTemplateJsonField
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
      />

      {/* Auth and Identity - available in both create and edit modes */}
      <SecretField
        label={t("localizationAgents.ui275_Gateway_auth_token")}
        value={
          isCreate
            ? values!.authToken ?? ""
            : effectiveGatewayToken
        }
        onCommit={(v) =>
          isCreate
            ? set!({ authToken: v })
            : commitGatewayToken(v)
        }
        placeholder={t("localizationAgents.ui276_OpenClaw_gateway_token")}
      />

      <Field label={t("localizationAgents.ui277_Agent_ID")}>
        <DraftInput
          value={
            isCreate
              ? values!.agentId ?? ""
              : eff("adapterConfig", "agentId", String(config.agentId ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ agentId: v })
              : mark("adapterConfig", "agentId", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="agent-123"
        />
      </Field>

      <Field label={t("localizationAgents.ui279_Session_strategy")}>
        <select
          value={
            isCreate
              ? values!.sessionKeyStrategy ?? "fixed"
              : sessionStrategy
          }
          onChange={(e) =>
            isCreate
              ? set!({ sessionKeyStrategy: e.target.value })
              : mark("adapterConfig", "sessionKeyStrategy", e.target.value)
          }
          className={inputClass}
        >
          <option value="fixed">{t("localizationCommon.billingType.fixed")}</option>
          <option value="issue">{t("localizationAgents.ui280_Per_issue")}</option>
          <option value="run">{t("localizationAgents.ui281_Per_run")}</option>
        </select>
      </Field>

      {(isCreate ? values!.sessionKeyStrategy ?? "fixed" : sessionStrategy) === "fixed" && (
        <Field label={t("localizationAgents.ui282_Session_key")}>
          <DraftInput
            value={
              isCreate
                ? values!.sessionKey ?? ""
                : eff("adapterConfig", "sessionKey", String(config.sessionKey ?? "paperclip"))
            }
            onCommit={(v) =>
              isCreate
                ? set!({ sessionKey: v })
                : mark("adapterConfig", "sessionKey", v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="paperclip"
          />
        </Field>
      )}

      <SecretField
        label={t("localizationAgents.ui284_Password_alternative_auth_")}
        value={
          isCreate
            ? values!.password ?? ""
            : eff("adapterConfig", "password", String(config.password ?? ""))
        }
        onCommit={(v) =>
          isCreate
            ? set!({ password: v })
            : mark("adapterConfig", "password", v || undefined)
        }
        placeholder={t("localizationAgents.ui285_Gateway_shared_password")}
      />

      <Field label={t("localizationSettings.role")}>
        <DraftInput
          value={
            isCreate
              ? values!.role ?? ""
              : eff("adapterConfig", "role", String(config.role ?? "operator"))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ role: v })
              : mark("adapterConfig", "role", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="operator"
        />
      </Field>

      <Field label={t("localizationAgents.ui287_Scopes_comma_separated_")}>
        <DraftInput
          value={
            isCreate
              ? values!.scopes ?? ""
              : eff("adapterConfig", "scopes", parseScopes(config.scopes ?? ["operator.admin"]))
          }
          onCommit={(v) => {
            const parsed = v
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean);
            if (isCreate) {
              set!({ scopes: v });
            } else {
              mark("adapterConfig", "scopes", parsed.length > 0 ? parsed : undefined);
            }
          }}
          immediate
          className={inputClass}
          placeholder="operator.admin"
        />
      </Field>

      <RuntimeServicesJsonField
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
      />

      <Field label={t("localizationAgents.ui289_Paperclip_API_URL_override")}>
        <DraftInput
          value={
            isCreate
              ? values!.paperclipApiUrl ?? ""
              : eff("adapterConfig", "paperclipApiUrl", String(config.paperclipApiUrl ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ paperclipApiUrl: v })
              : mark("adapterConfig", "paperclipApiUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="https://paperclip.example"
        />
      </Field>

      <Field label={t("localizationAgents.ui291_Timeout_seconds_")}>
        <DraftInput
          value={
            isCreate
              ? values!.timeoutSec != null ? String(values!.timeoutSec) : ""
              : eff("adapterConfig", "timeoutSec", String(config.timeoutSec ?? ""))
          }
          onCommit={(v) => {
            const parsed = Number.parseInt(v.trim(), 10);
            const val = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
            if (isCreate) {
              set!({ timeoutSec: val });
            } else {
              mark("adapterConfig", "timeoutSec", val);
            }
          }}
          immediate
          className={inputClass}
          placeholder="120"
        />
      </Field>

      <Field label={t("localizationAgents.ui292_Headers_JSON")}>
        <HeadersJsonTextarea
          isCreate={isCreate}
          createDraft={isCreate ? values!.headersJson ?? "" : ""}
          onCreateDraftChange={(next) => set!({ headersJson: next })}
          editStringified={JSON.stringify(eff("adapterConfig", "headers", config.headers ?? {}), null, 2)}
          onEditCommit={(next) => {
            const trimmed = next.trim();
            if (!trimmed) {
              mark("adapterConfig", "headers", undefined);
              return;
            }
            try {
              const parsed = JSON.parse(trimmed);
              if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                mark("adapterConfig", "headers", parsed);
              }
            } catch {
              // Keep local draft until JSON is valid
            }
          }}
          inputClass={inputClass}
        />
      </Field>

      {!isCreate && (
        <Field label={t("localizationAgents.ui293_Claimed_API_key_path")}>
          <DraftInput
            value={eff("adapterConfig", "claimedApiKeyPath", String(config.claimedApiKeyPath ?? ""))}
            onCommit={(v) => mark("adapterConfig", "claimedApiKeyPath", v || undefined)}
            immediate
            className={inputClass}
            placeholder="~/.openclaw/workspace/paperclip-claimed-api-key.json"
          />
        </Field>
      )}

      <Field label={t("localizationAgents.ui295_Wait_timeout_ms_")}>
        <DraftInput
          value={
            isCreate
              ? values!.waitTimeoutMs != null
                ? String(values!.waitTimeoutMs)
                : ""
              : eff("adapterConfig", "waitTimeoutMs", String(config.waitTimeoutMs ?? "120000"))
          }
          onCommit={(v) => {
            const parsed = Number.parseInt(v.trim(), 10);
            const next = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
            if (isCreate) {
              set!({ waitTimeoutMs: next });
            } else {
              mark("adapterConfig", "waitTimeoutMs", next);
            }
          }}
          immediate
          className={inputClass}
          placeholder="120000"
        />
      </Field>

      <Field label={t("localizationAgents.ui296_Disable_device_auth")}>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={
              isCreate
                ? values!.disableDeviceAuth ?? false
                : eff("adapterConfig", "disableDeviceAuth", Boolean(config.disableDeviceAuth ?? false))
            }
            onChange={(e) =>
              isCreate
                ? set!({ disableDeviceAuth: e.target.checked })
                : mark("adapterConfig", "disableDeviceAuth", e.target.checked || undefined)
            }
          />{t("localizationAgents.ui297_Skip_device_key_authentication")}</label>
      </Field>

      <Field label={t("localizationAgents.ui298_Auto_pair_on_first_connect")}>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={
              isCreate
                ? values!.autoPairOnFirstConnect ?? true
                : eff("adapterConfig", "autoPairOnFirstConnect", config.autoPairOnFirstConnect !== false)
            }
            onChange={(e) =>
              isCreate
                ? set!({ autoPairOnFirstConnect: e.target.checked })
                : mark("adapterConfig", "autoPairOnFirstConnect", e.target.checked)
            }
          />{t("localizationAgents.ui299_Automatically_approve_device_pairing")}</label>
      </Field>

      <Field label={t("localizationAgents.ui300_Device_auth")}>
        <div className="text-xs text-muted-foreground leading-relaxed">{t("localizationAgents.ui301_When_enabled_Paperclip_persists_a_device_key_during_onboardi")}</div>
      </Field>
    </>
  );
}
