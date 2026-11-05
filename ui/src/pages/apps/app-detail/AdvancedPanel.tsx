import { useTranslation, t as translate } from "@/i18n";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight, ChevronRight, Loader2, Lock } from "lucide-react";
import type {
  AppDefinition,
  ConnectionGrant,
  ToolConnection,
  ToolConnectionCredentialPolicy,
} from "@paperclipai/shared";
import { connectionCredentialConfigPath, credentialConfigPath, getAvailableConnectionMethod, humanizeConnectionDisplayName } from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useToast } from "@/context/ToastContext";
import { redactUrlSecrets } from "@/lib/redact-url-secrets";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { prepareOAuthNavigation, savePendingCloudHandoff } from "@/lib/oauthHandoff";
import { cn } from "@/lib/utils";
import { Link } from "@/lib/router";
import type { AppDetailSectionProps } from "./types";
import { RevokeGrantDialog } from "./IdentitiesSection";
import { describeError } from "@/api/errors";

export function AdvancedPanel({
  connection,
  appName,
  galleryEntry,
  removing,
  onRemove,
  onReplaced,
  canReplaceCredential = true,
  credentialUnavailableMessage = translate("connections:you_don_t_have_permission_to_replace_4040428"),
  appToggleDisabled,
  onToggleApp,
  identityGrant = null,
  identityCurrentUserId = null,
  identityProviderName,
  credentialPolicy,
  identityActionPending = false,
  onReconnectIdentity,
  onRevokeIdentity,
}: Pick<AppDetailSectionProps, "connection" | "appName" | "galleryEntry"> & {
  removing: boolean;
  onRemove: () => void;
  onReplaced: () => void;
  canReplaceCredential?: boolean;
  credentialUnavailableMessage?: string;
  appToggleDisabled: boolean;
  onToggleApp: () => void;
  identityGrant?: ConnectionGrant | null;
  identityCurrentUserId?: string | null;
  identityProviderName?: string;
  credentialPolicy?: ToolConnectionCredentialPolicy;
  identityActionPending?: boolean;
  onReconnectIdentity?: () => void;
  onRevokeIdentity?: (grant: ConnectionGrant) => void;
}) {
  useTranslation("connections");
  return (
    <div className="space-y-4 border-t border-border pt-8">
      <TechnicalDetails connection={connection} />
      <DangerZone
        appName={appName}
        connection={connection}
        galleryEntry={galleryEntry}
        removing={removing}
        onRemove={onRemove}
        onReplaced={onReplaced}
        canReplaceCredential={canReplaceCredential}
        credentialUnavailableMessage={credentialUnavailableMessage}
        toggleDisabled={appToggleDisabled}
        onToggleConnection={onToggleApp}
        identityGrant={identityGrant}
        identityCurrentUserId={identityCurrentUserId}
        identityProviderName={identityProviderName ?? appName}
        credentialPolicy={credentialPolicy}
        identityActionPending={identityActionPending}
        onReconnectIdentity={onReconnectIdentity}
        onRevokeIdentity={onRevokeIdentity}
      />
    </div>
  );
}

function connectionMethodUnavailable(connection: ToolConnection, galleryEntry: AppDefinition | null): boolean {
  const methodKey = connection.config?.connectionMethodKey;
  return typeof methodKey === "string"
    && methodKey.length > 0
    && !!galleryEntry
    && Array.isArray(galleryEntry.methods)
    && !getAvailableConnectionMethod(galleryEntry, methodKey);
}

function KeySection({
  connection,
  galleryEntry,
  onReplaced,
  canReplace,
  unavailableMessage,
}: {
  connection: ToolConnection;
  galleryEntry: AppDefinition | null;
  onReplaced: () => void;
  canReplace: boolean;
  unavailableMessage: string;
}) {
  const { t } = useTranslation("connections");
  const [open, setOpen] = useState(false);
  return (
    <section>
      <div className="flex items-center justify-between">
        <div className="flex items-start gap-3">
          <Lock className="mt-0.5 h-4 w-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-medium text-foreground">{t("reconnect_6988b16")}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {canReplace ? t("replace_the_stored_credential_3a69888") : unavailableMessage}
            </p>
          </div>
        </div>
        {canReplace && !open && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>{t("reconnect_cb5e9a6")}</Button>
        )}
      </div>
      {open && (
        <div className="pt-4">
          <ReconnectForm
            connection={connection}
            galleryEntry={galleryEntry}
            onCancel={() => setOpen(false)}
            onReconnected={() => {
              setOpen(false);
              onReplaced();
            }}
          />
        </div>
      )}
    </section>
  );
}

export function ReconnectCard({
  connection,
  galleryEntry,
  onReconnected,
  onReconnect,
  canReconnect = true,
  reconnectUnavailableMessage,
}: {
  connection: ToolConnection;
  galleryEntry: AppDefinition | null;
  onReconnected: () => void;
  onReconnect?: () => void;
  canReconnect?: boolean;
  reconnectUnavailableMessage?: string;
}) {
  const { t } = useTranslation("connections");
  const { pushToast } = useToast();
  const reconnectOAuth = useMutation({
    // Reconnect is not a new identity choice. Personal-only connections must
    // put the replacement token back on the signed-in user's existing grant;
    // shared and legacy fallback connections keep using the organization slot.
    mutationFn: () => connection.credentialPolicy === "per_user"
      ? toolsApi.startOAuth(connection.id, { asCurrentUser: true })
      : toolsApi.startOAuth(connection.id),
    onSuccess: async (start) => {
      try {
        const target = await prepareOAuthNavigation(start);
        if (target.kind === "reauthentication" && start.handoff) {
          savePendingCloudHandoff(start.handoff.session);
        }
        navigateTopLevel(target.url);
      } catch (error) {
        pushToast({
          title: t("couldn_t_start_sign_in_6da48b3"),
          body: describeError(error).body,
          tone: "error",
        });
      }
    },
    onError: (error) =>
      pushToast({
        title: t("couldn_t_start_sign_in_6da48b3"),
        body: describeError(error).body,
        tone: "error",
      }),
  });
  const verifyVercel = useMutation({
    mutationFn: () => toolsApi.checkConnectionHealth(connection.id),
    onSuccess: () => {
      pushToast({
        title: t("vercel_credential_verified_9dd646d"),
        body: t("is_back_online_a92ba22", { humanizeConnectionDisplayName: humanizeConnectionDisplayName(connection) }),
        tone: "success",
      });
      onReconnected();
    },
    onError: (error) => pushToast({
      title: t("credential_still_needs_attention_5566331"),
      body: describeError(error).body,
      tone: "error",
    }),
  });
  const oauth = connection.authKind === "oauth";
  const managedByVercel = connection.credentialSource === "vercel_connect";
  const methodUnavailable = connectionMethodUnavailable(connection, galleryEntry);

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-100">
          {methodUnavailable ? t("connection_no_longer_supported_440ac3e") : oauth ? t("reconnect_required_c8e1da0") : t("this_app_needs_reconnecting_806b033")}
        </h2>
        <p className="mt-0.5 text-sm text-amber-800 dark:text-amber-200">
          {methodUnavailable
            ? t("add_a_supported_connection_from_connectors_then_f387c9d")
            : connection.healthMessage?.trim() || (oauth
            ? t("authorization_expired_or_was_revoked_sign_in_190b7a6")
            : t("the_key_stopped_working_paste_a_new_da47e6b"))}
        </p>
      </div>
      <div className="shrink-0">
        {!canReconnect ? (
          <p className="text-sm text-amber-800 dark:text-amber-200">
            {reconnectUnavailableMessage ?? t("you_don_t_have_permission_to_reconnect_a8adf0b")}
          </p>
        ) : methodUnavailable ? (
          <Button size="sm" variant="outline" asChild>
            <Link to={`/apps/connect?source=${encodeURIComponent(galleryEntry!.slug)}`}>{t("add_supported_connection_6e0be6f")}</Link>
          </Button>
        ) : onReconnect ? (
          <Button size="sm" variant="outline" onClick={onReconnect}>{t("reconnect_6988b16")}</Button>
        ) : managedByVercel && !oauth ? (
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" asChild>
              <a href="https://vercel.com/connect" target="_blank" rel="noreferrer">{t("manage_in_vercel_0f70356")}<ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
              </a>
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={verifyVercel.isPending}
              onClick={() => verifyVercel.mutate()}
            >
              {verifyVercel.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}{t("check_again_5e59764")}</Button>
          </div>
        ) : oauth ? (
          <Button
            type="button"
            size="sm"
            disabled={reconnectOAuth.isPending}
            onClick={() => reconnectOAuth.mutate()}
          >
            {reconnectOAuth.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {reconnectOAuth.isPending ? t("opening_sign_in_fc76c48") : t("reconnect_6988b16")}
          </Button>
        ) : (
          <ReconnectForm connection={connection} galleryEntry={galleryEntry} onReconnected={onReconnected} />
        )}
      </div>
    </div>
  );
}

function ReconnectForm({
  connection,
  galleryEntry,
  onCancel,
  onReconnected,
}: {
  connection: ToolConnection;
  galleryEntry: AppDefinition | null;
  onCancel?: () => void;
  onReconnected: () => void;
}) {
  const { t } = useTranslation("connections");
  const { pushToast } = useToast();
  const methodKey = typeof connection.config?.connectionMethodKey === "string"
    ? connection.config.connectionMethodKey
    : null;
  const method = galleryEntry && Array.isArray(galleryEntry.methods)
    ? getAvailableConnectionMethod(galleryEntry, methodKey)
    : null;
  const galleryFields = (method?.credentialFields ?? []).map((field) => ({
    ...field,
    configPath: credentialConfigPath(field, method),
    helpUrl: method?.consoleLinks?.keys ?? method?.consoleLinks?.docs ?? "",
  }));
  const fields = galleryFields.length > 0 ? galleryFields : (connection.credentialRefs ?? [])
    .filter((ref) => ref.placement === "header" || ref.placement === "url")
    .map((ref) => ({
      configPath: connectionCredentialConfigPath(ref),
      label: ref.placement === "url" ? t("mcp_server_url_8ca3229") : ref.prefix === "Bearer " ? t("app_key_6d3fb61") : ref.key ?? ref.name,
      helpUrl: "",
      required: true,
    }));
  const [values, setValues] = useState<Record<string, string>>({});
  const [single, setSingle] = useState("");
  const usesFields = fields.length > 0;

  const reconnect = useMutation({
    mutationFn: () => {
      const credentialValues = usesFields
        ? values
        : { "credentials.authorization": single.trim() };
      return toolsApi.reconnectConnection(connection.id, credentialValues);
    },
    onSuccess: (result) => {
      const healthy =
        result.connection.healthStatus === "ok" || result.connection.healthStatus === "healthy" || result.connection.healthStatus === "unknown";
      if (healthy) {
        pushToast({
          title: t("reconnected_43e3de6"),
          body: t("is_back_online_a92ba22", { humanizeConnectionDisplayName: humanizeConnectionDisplayName(connection) }),
          tone: "success",
        });
        onReconnected();
      } else {
        pushToast({
          title: t("still_not_working_46fc2fc"),
          body: result.connection.healthMessage?.trim() || t("that_key_didn_t_check_out_try_8c12ab7"),
          tone: "error",
        });
      }
    },
    onError: (error) =>
      pushToast({
        title: t("that_key_didn_t_work_332d669"),
        body: describeError(error).body,
        tone: "error",
      }),
  });

  const filled = usesFields
    ? fields.every((f) => f.required === false || (values[f.configPath]?.trim().length ?? 0) > 0)
    : single.trim().length > 0;

  if (connection.credentialSource === "vercel_connect") {
    return (
      <p className="text-sm text-muted-foreground">{t("credentials_for_this_connection_are_managed_in_ac27959")}</p>
    );
  }

  return (
    <div className="space-y-3">
      {usesFields ? (
        fields.map((field) => (
          <div key={field.configPath}>
            <label className="text-xs font-medium text-foreground">{field.label}</label>
            <Input
              type="password"
              aria-label={field.label}
              autoComplete="off"
              value={values[field.configPath] ?? ""}
              onChange={(e) => setValues({ ...values, [field.configPath]: e.target.value })}
              placeholder="****************"
              className="mt-1 h-10 font-mono"
            />
            {field.helpUrl && (
              <a
                href={field.helpUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-foreground underline underline-offset-2"
              >{t("where_do_i_find_this_462c5e2")}<ArrowUpRight className="h-3 w-3" />
              </a>
            )}
          </div>
        ))
      ) : (
        <Input
          type="password"
          aria-label={t("app_key_6d3fb61")}
          autoComplete="off"
          value={single}
          onChange={(e) => setSingle(e.target.value)}
          placeholder={t("paste_your_new_key_65469ac")}
          className="h-10 font-mono"
        />
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!filled || reconnect.isPending} onClick={() => reconnect.mutate()}>
          {reconnect.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {reconnect.isPending ? t("checking_494d0f6") : t("check_reconnect_b8ed4fa")}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={reconnect.isPending}>{t("cancel_1791a62")}</Button>
        )}
      </div>
    </div>
  );
}

function TechnicalDetails({ connection }: { connection: ToolConnection }) {
  const { t } = useTranslation("connections");
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section>
        <CollapsibleTrigger asChild>
          <button type="button" className="flex w-full items-center gap-3 py-1 text-left">
            <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{t("connection_details_ab30a5c")}</span>
            <ChevronRight
              className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <dl className="mt-4 grid gap-2 pb-2 text-xs sm:grid-cols-(--gtc-59)">
            <dt className="text-muted-foreground">{t("address_d70f93d")}</dt>
            <dd className="break-all font-mono text-foreground">{connectionAddress(connection)}</dd>
            <dt className="text-muted-foreground">{t("type_3deb745")}</dt>
            <dd className="text-foreground">{connectionTransportLabel(connection.transport)}</dd>
          </dl>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

export function DangerZone({
  appName,
  connection,
  galleryEntry = null,
  removing,
  onRemove,
  onReplaced,
  canReplaceCredential = true,
  credentialUnavailableMessage = translate("connections:you_don_t_have_permission_to_replace_4040428"),
  toggleDisabled = false,
  onToggleConnection,
  identityGrant = null,
  identityCurrentUserId = null,
  identityProviderName = appName,
  credentialPolicy,
  identityActionPending = false,
  onReconnectIdentity,
  onRevokeIdentity,
}: {
  appName: string;
  connection?: ToolConnection;
  galleryEntry?: AppDefinition | null;
  removing: boolean;
  onRemove: () => void;
  onReplaced?: () => void;
  canReplaceCredential?: boolean;
  credentialUnavailableMessage?: string;
  toggleDisabled?: boolean;
  onToggleConnection?: () => void;
  identityGrant?: ConnectionGrant | null;
  identityCurrentUserId?: string | null;
  identityProviderName?: string;
  credentialPolicy?: ToolConnectionCredentialPolicy;
  identityActionPending?: boolean;
  onReconnectIdentity?: () => void;
  onRevokeIdentity?: (grant: ConnectionGrant) => void;
}) {
  const { t } = useTranslation("connections");
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ConnectionGrant | null>(null);
  const paused = connection
    ? connection.enabled === false || connection.status === "disabled"
    : false;
  const methodUnavailable = connection ? connectionMethodUnavailable(connection, galleryEntry) : false;

  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setConfirming(false);
      }}
      asChild
    >
      <section>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-3 py-1 text-left"
          >
            <span className="min-w-0 flex-1 text-sm font-medium text-destructive">{t("danger_zone_963a652")}</span>
            <ChevronRight
              className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
            />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="mt-3 divide-y divide-border border-t border-border">
            {connection && onToggleConnection ? (
              <div className="flex items-center justify-between gap-4 py-4">
                <h2 className="text-sm font-medium text-foreground">{t("pause_connection_b2e7c2d")}</h2>
                <ToggleSwitch
                  aria-label={t("pause_connection_b2e7c2d")}
                  checked={paused}
                  disabled={toggleDisabled}
                  onCheckedChange={onToggleConnection}
                  size="lg"
                />
              </div>
            ) : null}

            {connection && !methodUnavailable && connection.authKind !== "oauth" ? (
              <div className="py-4">
                <KeySection
                  connection={connection}
                  galleryEntry={galleryEntry}
                  onReplaced={onReplaced ?? (() => undefined)}
                  canReplace={canReplaceCredential}
                  unavailableMessage={credentialUnavailableMessage}
                />
              </div>
            ) : null}

            {connection?.authKind === "oauth" && !methodUnavailable && (onReconnectIdentity || !canReplaceCredential) ? (
              <div className="flex flex-wrap items-center justify-between gap-3 py-4">
                <div>
                  <p className="text-sm font-medium text-foreground">{t("reconnect_6988b16")}</p>
                  <p className="text-xs text-muted-foreground">
                    {canReplaceCredential
                      ? t("sign_in_to_again_e125f21", { identityProviderName: identityProviderName })
                      : credentialUnavailableMessage}
                  </p>
                </div>
                {canReplaceCredential && onReconnectIdentity ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={identityActionPending}
                    onClick={onReconnectIdentity}
                  >
                    {identityActionPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}{t("reconnect_cb5e9a6")}</Button>
                ) : null}
              </div>
            ) : null}

            {identityGrant?.capabilities?.canRevoke
              && identityGrant.status !== "revoked"
              && onRevokeIdentity ? (
                <div className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <div>
                    <p className="text-sm font-medium text-foreground">{t("revoke_identity_38a6af1")}</p>
                    <p className="text-xs text-muted-foreground">{t("disconnect_the_identity_currently_used_by_this_d02abc2")}</p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setRevokeTarget(identityGrant)}
                  >{t("revoke_f949472")}</Button>
                </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div>
                <p className="text-sm font-medium text-foreground">{t("remove_this_app_8c21bb3")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("deletes_credentials_for_and_removes_agent_access_29cf3f2", { appName: appName })}
                </p>
              </div>
              {confirming ? (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={removing}>{t("cancel_1791a62")}</Button>
                  <Button variant="destructive" size="sm" onClick={onRemove} disabled={removing}>
                    {removing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}{t("yes_remove_it_bdbfe30")}</Button>
                </div>
              ) : (
                <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>{t("remove_app_9609bc3")}</Button>
              )}
            </div>
          </div>
        </CollapsibleContent>

        {revokeTarget && credentialPolicy ? (
          <RevokeGrantDialog
            grant={revokeTarget}
            providerName={identityProviderName}
            pending={identityActionPending}
            credentialPolicy={credentialPolicy}
            isOwnIdentity={revokeTarget.kind === "user" && revokeTarget.subjectUserId === identityCurrentUserId}
            onCancel={() => setRevokeTarget(null)}
            onConfirm={() => {
              onRevokeIdentity?.(revokeTarget);
              setRevokeTarget(null);
            }}
          />
        ) : null}
      </section>
    </Collapsible>
  );
}

export function connectionAddress(connection: ToolConnection): string {
  const config = connection.config ?? connection.transportConfig ?? {};
  const value = config.url ?? config.endpoint ?? config.remoteUrl;
  if (typeof value === "string" && value.trim().length > 0) return redactUrlSecrets(value);
  if (connection.transport === "local_stdio") return translate("connections:local_command_3748f38");
  return translate("connections:not_set_93039e6");
}

export function connectionTransportLabel(transport: ToolConnection["transport"]): string {
  if (transport === "mcp_remote") return translate("connections:remote_http_99754bd");
  if (transport === "local_stdio") return translate("connections:local_command_3748f38");
  return translate("connections:unknown_bc7819b");
}
