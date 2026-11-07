import { useTranslation } from "@/i18n";
import { useId } from "react";
import { Plus, UserRound } from "lucide-react";
import {
  aiConnectionCatalogSlug,
  isAiConnectionCompatible,
  type AiConnectionBinding,
} from "@paperclipai/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AppLogo } from "@/pages/apps/AppLogo";
import { Button } from "@/components/ui/button";
import { aiConnectionDisplayLabel, aiConnectionProblem, personalAiDefault } from "./model";
import type { AiConnectionPickerProps } from "./AiConnectionPicker";
import type { AiConnectionSummary } from "./model";

function ConnectionLabel({ connection, label, wrap = false }: { connection: AiConnectionSummary; label?: string; wrap?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <AppLogo name={connection.name} brandKey={aiConnectionCatalogSlug(connection.provider, connection.routing)} size={20} compact />
      <span className={wrap ? "min-w-0 break-words whitespace-normal" : "truncate"}>{label ?? aiConnectionDisplayLabel(connection)}</span>
    </span>
  );
}

/** The same connection control on Create agent and Harness / Runtime. */
export function AiConnectionSelect({
  requirement,
  connections,
  value,
  currentUserId,
  readOnly,
  loading,
  error,
  onRetry,
  onConnect,
  onReconnect,
  onChange,
  adapterType,
  model,
}: AiConnectionPickerProps & { adapterType: string; model?: string }) {
  const { t } = useTranslation("connections");
  const selectId = useId();
  const personal = personalAiDefault(connections, requirement, currentUserId);
  const selected =
    value?.mode === "responsible_user"
      ? personal
      : connections.find(
          (c) => c.id === value?.connectionId && c.grantId === value?.grantId,
        );
  const compatibilityModel = (provider: string) => adapterType === "pi_local"
    ? model || `${provider}/` : provider === "openrouter" ? "openrouter/" : undefined;
  const compatible = connections
    .filter(
      (c) =>
        c.companyId === requirement.companyId &&
        isAiConnectionCompatible(
          c,
          adapterType,
          compatibilityModel(c.provider),
        ),
    )
    .sort(
      (a, b) =>
        Number(b.id === selected?.id) - Number(a.id === selected?.id) ||
        Number(Boolean(a.routing)) - Number(Boolean(b.routing)) ||
        a.name.localeCompare(b.name),
    );
  const unavailable = Boolean(
    value &&
      value.mode !== "responsible_user" &&
      !selected &&
      !loading &&
      !error,
  );
  const canUseDefault = isAiConnectionCompatible(
    {
      provider: requirement.provider,
      method: "api_key",
      mode: "responsible_user",
    },
    adapterType,
    compatibilityModel(requirement.provider),
  );
  const incompatible =
    selected && !compatible.some((c) => c.id === selected.id);
  const change = (id: string) => {
    if (id === "connect") return onConnect();
    if (id === "responsible_user")
      return onChange({
        provider: requirement.provider,
        method: personal?.method ?? "api_key",
        mode: "responsible_user",
      });
    const connection = compatible.find((c) => c.id === id);
    if (!connection) return;
    onChange({
      provider: connection.provider,
      method: connection.method,
      mode: connection.ownership === "shared" ? "shared" : "delegated",
      connectionId: connection.id,
      grantId: connection.grantId,
    } satisfies AiConnectionBinding);
  };
  return (
    <div className="space-y-2">
      <label className="text-xs text-muted-foreground" htmlFor={selectId}>{t("connection_b7e7b93")}</label>
      <Select
        value={
          value?.mode === "responsible_user"
            ? "responsible_user"
            : (value?.connectionId ?? "")
        }
        onValueChange={change}
        disabled={readOnly || loading || Boolean(error)}
      >
        <SelectTrigger id={selectId} aria-label={t("connection_6512ee1")} title={selected ? aiConnectionDisplayLabel(selected) : undefined} className="w-full">
          <SelectValue
            placeholder={
              loading ? t("loading_connections_e2e03ef") : t("choose_a_connection_4282394")
            }
          >
            {selected
              ? <ConnectionLabel connection={selected} label={value?.mode === "responsible_user" ? t("responsible_user_s_default_3d46de2") : undefined} />
              : value?.mode === "responsible_user"
                ? t("responsible_user_s_default_3d46de2")
                : value ? t("unavailable_connection_dfd2913") : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {incompatible && selected && (
            <SelectItem value={selected.id} disabled>
              <ConnectionLabel connection={selected} label={t("incompatible_64865a0", { value: aiConnectionDisplayLabel(selected) })} wrap />
            </SelectItem>
          )}
          {compatible.map((c) => (
            <SelectItem
              key={c.id}
              value={c.id}
              disabled={Boolean(aiConnectionProblem(c))}
            >
              <ConnectionLabel connection={c} label={`${aiConnectionDisplayLabel(c)}${c.status !== "connected" ? t("reconnect_8a6dde3") : ""}`} wrap />
            </SelectItem>
          ))}
          {(canUseDefault || value?.mode === "responsible_user") && (
            <SelectItem value="responsible_user" disabled={!canUseDefault}>
              <span className="flex size-5 shrink-0 items-center justify-center"><UserRound className="size-4" /></span>{t("responsible_user_s_default_618b4e8")}</SelectItem>
          )}
          <SelectItem value="connect">
            <span className="flex size-5 shrink-0 items-center justify-center"><Plus className="size-4" /></span>{t("connect_an_account_0da7b3a")}</SelectItem>
        </SelectContent>
      </Select>
      {!readOnly && onReconnect && !loading && !error && (
        <Button type="button" variant="outline" onClick={onReconnect}>{t("reconnect_account_75e1bf0")}</Button>
      )}
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button type="button" variant="outline" onClick={onRetry}>{t("retry_connections_659ee66")}</Button>
        </div>
      )}
      {value?.mode === "responsible_user" && !personal && !loading && !error ? (
        <p role="alert" className="text-sm text-destructive">{t("you_have_no_default_account_for_this_5c85749")}</p>
      ) : unavailable ? (
        <p role="alert" className="text-sm text-destructive">{t("this_connection_is_unavailable_choose_another_connection_c1f21ee")}</p>
      ) : incompatible ? (
        <p role="alert" className="text-sm text-destructive">{t("this_connection_does_not_support_the_selected_8d06f04")}</p>
      ) : selected && aiConnectionProblem(selected) ? (
        <p role="alert" className="text-sm text-destructive">
          {aiConnectionProblem(selected)}
        </p>
      ) : null}
    </div>
  );
}
