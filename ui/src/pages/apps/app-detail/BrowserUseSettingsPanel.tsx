import { t as finalPagesT } from "@/i18n";
import { useTranslation } from "@/i18n";
import { useEffect, useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  ConnectionGrantsResponse,
  ToolConnection,
} from "@paperclipai/shared";
import { browserUseApi } from "@/api/browser-use";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

function CredentialSettings({
  companyId,
  grantId,
}: {
  companyId: string;
  grantId: string;
}) {
  const { t } = useTranslation("connections");
  const id = useId();
  const saved = useQuery({
    queryKey: ["browser-use-cloud-settings", grantId],
    queryFn: () => browserUseApi.settings(companyId, grantId),
  });
  const profiles = useQuery({
    queryKey: ["browser-use-cloud-profiles", grantId],
    queryFn: () => browserUseApi.profiles(companyId, grantId),
  });
  const savedView = useQueryView(saved);
  const profilesView = useQueryView(profiles);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [limit, setLimit] = useState("");
  useEffect(() => {
    if (saved.data) {
      setAllowed(saved.data.allowedProfileIds);
      setLimit(saved.data.maxCostUsd?.toString() ?? "");
    }
  }, [saved.data]);
  const save = useMutation({
    mutationFn: () =>
      browserUseApi.saveSettings(companyId, grantId, {
        allowedProfileIds: allowed,
        maxCostUsd: limit ? Number(limit) : null,
      }),
    onSuccess: () => {
      void saved.refetch();
    },
  });
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={`${id}-limit`}>{t("maximum_cost_per_browser_run_usd_d2d1188")}</Label>
        <Input
          id={`${id}-limit`}
          type="number"
          min="0"
          step="0.01"
          value={limit}
          placeholder={t("use_the_remaining_paperclip_budget_eca499f")}
          onChange={(e) => setLimit(e.target.value)}
        />
        <p className="text-sm text-muted-foreground">{t("the_agent_can_choose_a_lower_limit_c33d36b")}</p>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("allowed_saved_profiles_5f73411")}</legend>
        <p className="text-sm text-muted-foreground">{t("fresh_browsers_are_the_default_selected_profiles_66c575f")}{" "}
          <a
            href="https://cloud.browser-use.com"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >{t("browser_use_cloud_32c9e60")}</a>
          .
        </p>
        {profiles.data?.map((p) => (
          <Label key={p.id} className="flex items-center gap-2">
            <Checkbox
              checked={allowed.includes(p.id)}
              onCheckedChange={(checked) =>
                setAllowed((previous) =>
                  checked
                    ? [...previous, p.id]
                    : previous.filter((id) => id !== p.id),
                )
              }
            />
            {p.name ?? p.id}
          </Label>
        ))}
        {profiles.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("no_saved_profiles_c56c16e")}</p>
        )}
        {(profiles.isLoading || profilesView.kind === "reconnecting") && (
          <p className="text-sm text-muted-foreground">{t("loading_profiles_b8f34c5")}</p>
        )}
        {profilesView.kind === "error" && (
          <QueryErrorState
            size="inline"
            error={profiles.error}
            action="load profiles"
            onRetry={profilesView.retry}
            retrying={profilesView.isFetching}
          />
        )}
      </fieldset>
      {savedView.kind === "error" ? (
        <QueryErrorState
          error={saved.error}
          action="load browser settings"
          onRetry={savedView.retry}
          retrying={savedView.isFetching}
        />
      ) : null}
      {save.error ? (
        <p role="alert" className="text-sm text-destructive">{t("could_not_save_browser_settings_check_your_18139ad")}</p>
      ) : null}
      {save.isSuccess && (
        <p role="status" className="text-sm text-muted-foreground">{t("browser_settings_saved_7ca2ebb")}</p>
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={
            !saved.data ||
            save.isPending ||
            Boolean(
              limit && (!Number.isFinite(Number(limit)) || Number(limit) <= 0),
            )
          }
          onClick={() => save.mutate()}
        >{t("save_browser_settings_a42122b")}</Button>
      </div>
    </div>
  );
}
export function BrowserUseSettingsPanel({
  connection,
  grants,
}: {
  connection: ToolConnection;
  grants?: ConnectionGrantsResponse;
}) {
  const { t } = useTranslation("connections");
  const eligible =
    grants?.grants.filter(
      (g) =>
        g.status === "active" &&
        ((g.kind === "organization" && g.capabilities?.canEditAudience) ||
          g.subjectUserId === grants.currentUserId ||
          g.createdByUserId === grants.currentUserId),
    ) ?? [];
  const [selected, setSelected] = useState("");
  const grantId = selected || eligible[0]?.id;
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">{t("browser_settings_27e3c51")}</h2>
      {eligible.length > 1 && (
        <Label className="flex flex-col gap-2">{t("credential_bfab607")}<select
            value={grantId}
            onChange={(e) => setSelected(e.target.value)}
            className="rounded-md border bg-background p-2"
          >
            {eligible.map((g, i) => (
              <option key={g.id} value={g.id}>
                {g.kind === "user" ? finalPagesT("final-pages:Personal_credential_number_17d8fe", { number: i + 1 }) : finalPagesT("final-pages:Shared_credential_number_cea3db", { number: i + 1 })}
              </option>
            ))}
          </select>
        </Label>
      )}
      {grantId ? (
        <CredentialSettings
          key={grantId}
          companyId={connection.companyId}
          grantId={grantId}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t("the_credential_owner_or_a_shared_connection_4ae6153")}</p>
      )}
    </section>
  );
}
