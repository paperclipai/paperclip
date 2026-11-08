import { useTranslation } from "@/i18n";
import { useEffect, useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConfigureRailwaySsh, ConnectionGrantsResponse, RailwaySshSetup, ToolConnection } from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function RailwayAccessPanel({ connection, grants }: { connection: ToolConnection; grants?: ConnectionGrantsResponse }) {
  const { t } = useTranslation("connections");
  const queryClient = useQueryClient();
  const id = useId();
  const setup = connection.config?.railwaySsh as RailwaySshSetup | null | undefined;
  const owned = (grants?.grants ?? []).filter((grant) => grant.kind !== "user" || grant.subjectUserId === grants?.currentUserId);
  const eligible = owned.filter((grant) => grant.status === "active");
  const [selectedGrant, setSelectedGrant] = useState("");
  const [knownHosts, setKnownHosts] = useState(setup?.knownHosts ?? "");
  useEffect(() => { setKnownHosts(setup?.knownHosts ?? ""); }, [setup?.knownHosts]);
  const grantId = setup?.grantId ?? (selectedGrant || eligible[0]?.id);
  const canConfigure = grants?.capabilities.canConfigure && connection.status === "active" && eligible.some((grant) => grant.id === grantId);
  const canRemove = grants?.capabilities.canConfigure && owned.some((grant) => grant.id === setup?.grantId);
  const mutation = useMutation({
    mutationFn: (input: ConfigureRailwaySsh) => toolsApi.configureRailwaySsh(connection.id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tools.connection(connection.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.tools.connectionGrants(connection.id) });
    },
  });
  return <section className="space-y-4" aria-labelledby={`${id}-title`}>
    <div className="space-y-2">
      <h2 id={`${id}-title`} className="text-lg font-semibold">{t("railway_operations_c658344")}</h2>
      <p className="text-sm text-muted-foreground">
        {typeof connection.config?.railwayApiMessage === "string" ? connection.config?.railwayApiMessage : t("refresh_actions_after_connecting_to_check_service_1af2804")}
      </p>
    </div>
    <div className="space-y-2">
      <h3 className="font-medium">{t("container_access_9d17b7c")}</h3>
      <p className="text-sm text-muted-foreground">{t("to_allow_paperclip_direct_ssh_access_to_0ecbb26")}<a className="underline" href="https://docs.railway.com/cli/ssh" target="_blank" rel="noreferrer">{t("railway_ssh_documentation_dce0ff6")}</a></p>
    </div>
    {!canConfigure && <p className="text-sm text-muted-foreground">{t("the_connection_manager_and_authorization_owner_can_c8478e4")}</p>}
    {(canConfigure || canRemove) && grantId && <>
      {!setup && eligible.length > 1 && <div className="space-y-2">
        <Label htmlFor={`${id}-grant`}>{t("authorization_5e25ce0")}</Label>
        <select id={`${id}-grant`} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={grantId} onChange={(event) => setSelectedGrant(event.target.value)}>
          {eligible.map((grant) => <option key={grant.id} value={grant.id}>{grant.kind === "organization" ? t("shared_account_4658bd0") : grant.kind === "user" ? t("my_account_6190981") : t("agent_account_16cff59")}</option>)}
        </select>
      </div>}
      {!setup && <Button variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "prepare", grantId })}>{t("generate_ssh_key_pair_0448117")}</Button>}
      {setup && <>
        <div className="space-y-2">
          <Label htmlFor={`${id}-public`}>{t("public_key_affb45c")}</Label>
          <Textarea id={`${id}-public`} readOnly value={setup.publicKey} className="font-mono text-xs" />
          <p className="text-sm text-muted-foreground">{t("register_this_public_key_in_the_railway_9ca1af8")}<a className="underline" href="https://docs.railway.com/cli/ssh#manage-ssh-keys" target="_blank" rel="noreferrer">{t("railway_key_setup_b6cbc44")}</a></p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-host`}>{t("verified_railway_host_key_7cfedc2")}</Label>
          <Textarea id={`${id}-host`} value={knownHosts} onChange={(event) => setKnownHosts(event.target.value)} placeholder={t("ssh_railway_com_ssh_ed25519_946b530")} className="font-mono text-xs" />
          <p className="text-sm text-muted-foreground">{t("paste_the_ssh_railway_com_line_from_027826a")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={!canConfigure || mutation.isPending || !knownHosts.trim()} onClick={() => mutation.mutate({ action: "enable", grantId, knownHosts })}>{setup.enabled ? t("update_trusted_host_key_9961b2e") : t("enable_container_access_e84b6f4")}</Button>
          <Button variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "remove", grantId })}>{t("remove_container_key_59a3378")}</Button>
        </div>
        <p className="text-sm text-muted-foreground">{t("removing_the_key_stops_new_paperclip_connections_ad201a8", { accessStatus: setup.enabled ? t("reviewBRailwayEnabled") : t("reviewBRailwayPrerequisites") })}</p>
      </>}
    </>}
    {mutation.error ? <p role="alert" className="text-sm text-destructive">{describeError(mutation.error).body}</p> : null}
  </section>;
}
