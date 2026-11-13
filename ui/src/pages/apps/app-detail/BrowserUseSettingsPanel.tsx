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
        <Label htmlFor={`${id}-limit`}>
          Maximum cost per browser run (USD)
        </Label>
        <Input
          id={`${id}-limit`}
          type="number"
          min="0"
          step="0.01"
          value={limit}
          placeholder="Use the remaining Paperclip budget"
          onChange={(e) => setLimit(e.target.value)}
        />
        <p className="text-sm text-muted-foreground">
          The agent can choose a lower limit. Paperclip also applies any
          remaining hard budget limit.
        </p>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Allowed saved profiles</legend>
        <p className="text-sm text-muted-foreground">
          Fresh browsers are the default. Selected profiles let agents use their
          saved website logins. Manage profiles in{" "}
          <a
            href="https://cloud.browser-use.com"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Browser Use Cloud
          </a>
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
          <p className="text-sm text-muted-foreground">No saved profiles.</p>
        )}
        {(profiles.isLoading || profilesView.kind === "reconnecting") && (
          <p className="text-sm text-muted-foreground">Loading profiles…</p>
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
        <p role="alert" className="text-sm text-destructive">
          Could not save browser settings. Check your credential access and try
          again.
        </p>
      ) : null}
      {save.isSuccess && (
        <p role="status" className="text-sm text-muted-foreground">
          Browser settings saved.
        </p>
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
        >
          Save browser settings
        </Button>
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
      <h2 className="text-lg font-semibold">Browser settings</h2>
      {eligible.length > 1 && (
        <Label className="flex flex-col gap-2">
          Credential
          <select
            value={grantId}
            onChange={(e) => setSelected(e.target.value)}
            className="rounded-md border bg-background p-2"
          >
            {eligible.map((g, i) => (
              <option key={g.id} value={g.id}>
                {g.kind === "user" ? "Personal" : "Shared"} credential {i + 1}
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
        <p className="text-sm text-muted-foreground">
          The credential owner or a shared connection manager can configure
          saved profiles and cost limits.
        </p>
      )}
    </section>
  );
}
