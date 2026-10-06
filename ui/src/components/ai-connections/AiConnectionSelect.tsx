import { t, useTranslation } from "@/i18n";
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
import { aiConnectionProblem, personalAiDefault } from "./model";
import type { AiConnectionPickerProps } from "./AiConnectionPicker";
import type { AiConnectionSummary } from "./model";

function ConnectionLabel({ connection, label }: { connection: AiConnectionSummary; label?: string }) {
  useTranslation();
  return (
    <span className="flex min-w-0 items-center gap-2">
      <AppLogo name={connection.name} brandKey={aiConnectionCatalogSlug(connection.provider, connection.routing)} size={20} compact />
      <span className="truncate">{label ?? connection.name}</span>
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
}: AiConnectionPickerProps & { adapterType: string }) {
  useTranslation();
  const selectId = useId();
  const personal = personalAiDefault(connections, requirement, currentUserId);
  const selected =
    value?.mode === "responsible_user"
      ? personal
      : connections.find(
          (c) => c.id === value?.connectionId && c.grantId === value?.grantId,
        );
  const compatible = connections
    .filter(
      (c) =>
        c.companyId === requirement.companyId &&
        isAiConnectionCompatible(
          c,
          adapterType,
          c.provider === "openrouter" ? "openrouter/" : undefined,
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
    requirement.provider === "openrouter" ? "openrouter/" : undefined,
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
      <label className="text-xs text-muted-foreground" htmlFor={selectId}>
        {t("localizationIssueAux.ui_Connection_2r1h4p")}
      </label>
      <Select
        value={
          value?.mode === "responsible_user"
            ? "responsible_user"
            : (value?.connectionId ?? "")
        }
        onValueChange={change}
        disabled={readOnly || loading || Boolean(error)}
      >
        <SelectTrigger id={selectId} aria-label={t("localizationIssueAux.ui_Connection_2r1h4p")} className="w-full">
          <SelectValue
            placeholder={
              loading ? t("oct6Beta.copy042") : t("oct6Beta.copy073")
            }
          >
            {selected
              ? <ConnectionLabel connection={selected} label={value?.mode === "responsible_user" ? t("oct6Beta.copy074") : undefined} />
              : value?.mode === "responsible_user"
                ? t("oct6Beta.copy074")
                : value ? t("oct6Beta.copy075") : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {incompatible && selected && (
            <SelectItem value={selected.id} disabled>
              <ConnectionLabel connection={selected} label={t("oct6Beta.dynamic056", { v0: selected.name })} />
            </SelectItem>
          )}
          {compatible.map((c) => (
            <SelectItem
              key={c.id}
              value={c.id}
              disabled={Boolean(aiConnectionProblem(c))}
            >
              <ConnectionLabel connection={c} label={c.status !== "connected" ? t("oct6Beta.reconnectCaption", { name: c.name }) : c.name} />
            </SelectItem>
          ))}
          {(canUseDefault || value?.mode === "responsible_user") && (
            <SelectItem value="responsible_user" disabled={!canUseDefault}>
              <span className="flex size-5 shrink-0 items-center justify-center"><UserRound className="size-4" /></span>
              {t("oct6Beta.copy074")}
            </SelectItem>
          )}
          <SelectItem value="connect">
            <span className="flex size-5 shrink-0 items-center justify-center"><Plus className="size-4" /></span>
            {t("oct6Beta.copy076")}
          </SelectItem>
        </SelectContent>
      </Select>
      {!readOnly && onReconnect && !loading && !error && (
        <Button type="button" variant="outline" onClick={onReconnect}>{t("sep13Connections.reconnectAccount")}</Button>
      )}
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button type="button" variant="outline" onClick={onRetry}>
            {t("sep13Connections.retryConnections")}
          </Button>
        </div>
      )}
      {value?.mode === "responsible_user" && !personal && !loading && !error ? (
        <p role="alert" className="text-sm text-destructive">
          {t("oct6Beta.copy077")}
        </p>
      ) : unavailable ? (
        <p role="alert" className="text-sm text-destructive">
          {t("oct6Beta.copy078")}
        </p>
      ) : incompatible ? (
        <p role="alert" className="text-sm text-destructive">
          {t("oct6Beta.copy079")}
        </p>
      ) : selected && aiConnectionProblem(selected) ? (
        <p role="alert" className="text-sm text-destructive">
          {aiConnectionProblem(selected)}
        </p>
      ) : null}
    </div>
  );
}
