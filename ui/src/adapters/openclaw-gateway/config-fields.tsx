import { useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("adapters");
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
      <Field label={t("openclaw.gateway_url")} hint={help.webhookUrl}>
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
          placeholder={t("openclaw.gateway_url_placeholder")}
        />
      </Field>

      <PayloadTemplateJsonField
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
      />

      <RuntimeServicesJsonField
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
      />

      {!isCreate && (
        <>
          <Field label={t("openclaw.api_url_override")}>
            <DraftInput
              value={
                eff(
                  "adapterConfig",
                  "paperclipApiUrl",
                  String(config.paperclipApiUrl ?? ""),
                )
              }
              onCommit={(v) => mark("adapterConfig", "paperclipApiUrl", v || undefined)}
              immediate
              className={inputClass}
              placeholder={t("openclaw.api_url_placeholder")}
            />
          </Field>

          <Field label={t("openclaw.claimed_api_key_path")}>
            <DraftInput
              value={eff("adapterConfig", "claimedApiKeyPath", String(config.claimedApiKeyPath ?? ""))}
              onCommit={(v) => mark("adapterConfig", "claimedApiKeyPath", v || undefined)}
              immediate
              className={inputClass}
              placeholder={t("openclaw.claimed_api_key_placeholder")}
            />
          </Field>

          <Field label={t("openclaw.session_strategy")}>
            <select
              value={sessionStrategy}
              onChange={(e) => mark("adapterConfig", "sessionKeyStrategy", e.target.value)}
              className={inputClass}
            >
              <option value="fixed">{t("openclaw.session_strategy_fixed")}</option>
              <option value="issue">{t("openclaw.session_strategy_issue")}</option>
              <option value="run">{t("openclaw.session_strategy_run")}</option>
            </select>
          </Field>

          {sessionStrategy === "fixed" && (
            <Field label={t("openclaw.session_key")}>
              <DraftInput
                value={eff("adapterConfig", "sessionKey", String(config.sessionKey ?? "paperclip"))}
                onCommit={(v) => mark("adapterConfig", "sessionKey", v || undefined)}
                immediate
                className={inputClass}
                placeholder={t("openclaw.session_key_placeholder")}
              />
            </Field>
          )}

          <SecretField
            label={t("openclaw.gateway_auth_token")}
            value={effectiveGatewayToken}
            onCommit={commitGatewayToken}
            placeholder={t("openclaw.gateway_auth_placeholder")}
          />

          <Field label={t("openclaw.role")}>
            <DraftInput
              value={eff("adapterConfig", "role", String(config.role ?? "operator"))}
              onCommit={(v) => mark("adapterConfig", "role", v || undefined)}
              immediate
              className={inputClass}
              placeholder={t("openclaw.role_placeholder")}
            />
          </Field>

          <Field label={t("openclaw.scopes")}>
            <DraftInput
              value={eff("adapterConfig", "scopes", parseScopes(config.scopes ?? ["operator.admin"]))}
              onCommit={(v) => {
                const parsed = v
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter(Boolean);
                mark("adapterConfig", "scopes", parsed.length > 0 ? parsed : undefined);
              }}
              immediate
              className={inputClass}
              placeholder={t("openclaw.scopes_placeholder")}
            />
          </Field>

          <Field label={t("openclaw.wait_timeout")}>
            <DraftInput
              value={eff("adapterConfig", "waitTimeoutMs", String(config.waitTimeoutMs ?? "120000"))}
              onCommit={(v) => {
                const parsed = Number.parseInt(v.trim(), 10);
                mark(
                  "adapterConfig",
                  "waitTimeoutMs",
                  Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
                );
              }}
              immediate
              className={inputClass}
              placeholder={t("openclaw.wait_timeout_placeholder")}
            />
          </Field>

          <Field label={t("openclaw.device_auth")}>
            <div className="text-xs text-muted-foreground leading-relaxed">
              {t("openclaw.device_auth_desc")}
            </div>
          </Field>
        </>
      )}
    </>
  );
}
