import { t, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { useEffect, useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  ConnectionGrantsResponse,
  ToolConnection,
} from "@paperclipai/shared";
import { browserUseApi } from "@/api/browser-use";
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
  useTranslation();
  const id = useId();
  const saved = useQuery({
    queryKey: ["browser-use-cloud-settings", grantId],
    queryFn: () => browserUseApi.settings(companyId, grantId),
  });
  const profiles = useQuery({
    queryKey: ["browser-use-cloud-profiles", grantId],
    queryFn: () => browserUseApi.profiles(companyId, grantId),
    retry: false,
  });
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
        <Label htmlFor={`${id}-limit`}>{t("oct5Apps.copy068")}</Label>
        <Input
          id={`${id}-limit`}
          type="number"
          min="0"
          step="0.01"
          value={limit}
          placeholder={t("oct5Apps.copy069")}
          onChange={(e) => setLimit(e.target.value)}
        />
        <p className="text-sm text-muted-foreground">{t("oct5Apps.copy070")}</p>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("oct5Apps.copy071")}</legend>
        <p className="text-sm text-muted-foreground">
          <Trans i18nKey="oct5Apps.browserProfiles" components={{ cloud: <a href="https://cloud.browser-use.com" target="_blank" rel="noreferrer" className="underline" /> }} />
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
          <p className="text-sm text-muted-foreground">{t("oct5Apps.copy072")}</p>
        )}
        {profiles.isLoading && (
          <p className="text-sm text-muted-foreground">{t("oct5Apps.copy073")}</p>
        )}
        {profiles.isError && (
          <p role="alert" className="text-sm text-destructive">{t("oct5Apps.copy074")}{" "}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void profiles.refetch()}
            >{t("stable916Shell.retry")}</Button>
          </p>
        )}
      </fieldset>
      {saved.isError || save.isError ? (
        <p role="alert" className="text-sm text-destructive">{t("oct5Apps.copy075")}</p>
      ) : null}
      {save.isSuccess && (
        <p role="status" className="text-sm text-muted-foreground">{t("oct5Apps.copy076")}</p>
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
        >{t("oct5Apps.copy077")}</Button>
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
  useTranslation();
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
      <h2 className="text-lg font-semibold">{t("oct5Apps.copy078")}</h2>
      {eligible.length > 1 && (
        <Label className="flex flex-col gap-2">{t("oct5Apps.copy135")}<select
            value={grantId}
            onChange={(e) => setSelected(e.target.value)}
            className="rounded-md border bg-background p-2"
          >
            {eligible.map((g, i) => (
              <option key={g.id} value={g.id}>
                {t(g.kind === "user" ? "oct5Apps.personalCredential" : "oct5Apps.sharedCredential", { number: i + 1 })}
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
        <p className="text-sm text-muted-foreground">{t("oct5Apps.copy079")}</p>
      )}
    </section>
  );
}
