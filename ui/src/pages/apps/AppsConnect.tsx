import { useMemo, useState } from "react";
import { useNavigate } from "@/lib/router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, KeyRound, LogIn } from "lucide-react";
import type { AppGalleryEntry } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/context/CompanyContext";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { AppLogo } from "./AppLogo";
import { appCopyFor, credentialFieldLabel } from "@/lib/app-gallery-copy";

function GalleryButton({
  app,
  selected,
  onSelect,
}: {
  app: AppGalleryEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-md border p-3 text-left transition ${
        selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
      }`}
    >
      <AppLogo name={app.name} logoUrl={app.logoUrl} size={32} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{app.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{appCopyFor(app.key, app.tagline).tagline}</span>
      </span>
    </button>
  );
}

export function AppsConnect() {
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [credentialValue, setCredentialValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const gallery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.apps.gallery(selectedCompanyId) : ["apps", "gallery", "none"],
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const apps = gallery.data?.apps ?? [];
  const selected = useMemo(
    () => apps.find((app) => app.key === selectedKey) ?? apps[0] ?? null,
    [apps, selectedKey],
  );

  const connect = useMutation({
    mutationFn: async (app: AppGalleryEntry) => {
      if (!selectedCompanyId) throw new Error("Choose a company first.");
      const credentialField = app.credentialFields[0];
      const result = await toolsApi.connectApp(selectedCompanyId, {
        galleryKey: app.key,
        credentialValues: credentialField ? { [credentialField.configPath]: credentialValue } : undefined,
      });
      if (result.auth?.kind === "oauth") {
        const startUrl = result.auth.startUrl ?? (await toolsApi.startOAuth(result.connectionId)).authorizationUrl;
        window.location.assign(startUrl);
        return result;
      }
      navigate("/apps");
      return result;
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Could not connect app."),
  });

  const credentialField = selected?.credentialFields[0] ?? null;
  const canSubmit = Boolean(selected) && (selected?.authKind !== "api_key" || credentialValue.trim().length > 0);
  const actionLabel = selected?.authKind === "oauth"
    ? `Sign in to ${selected.name}`
    : selected?.authKind === "api_key"
      ? `Connect ${selected.name}`
      : `Add ${selected?.name ?? "app"}`;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate("/apps")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <h1 className="mt-3 text-2xl font-semibold text-foreground">Connect app</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(240px,360px)_1fr]">
        <div className="space-y-2">
          {gallery.isLoading ? (
            <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">Loading apps...</div>
          ) : (
            apps.map((app) => (
              <GalleryButton
                key={app.key}
                app={app}
                selected={(selected?.key ?? null) === app.key}
                onSelect={() => {
                  setSelectedKey(app.key);
                  setCredentialValue("");
                  setError(null);
                }}
              />
            ))
          )}
        </div>

        <div className="rounded-md border border-border p-5">
          {selected ? (
            <div className="max-w-xl space-y-5">
              <div className="flex items-center gap-3">
                <AppLogo name={selected.name} logoUrl={selected.logoUrl} size={40} />
                <div>
                  <h2 className="text-lg font-medium text-foreground">{selected.name}</h2>
                  <p className="text-sm text-muted-foreground">{appCopyFor(selected.key, selected.tagline).short}</p>
                </div>
              </div>

              {selected.authKind === "oauth" ? (
                <div className="rounded-md border border-border bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <LogIn className="h-4 w-4" />
                    Sign in required
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Sign in with {selected.name}, then return here to choose actions and who can use it.
                  </p>
                </div>
              ) : credentialField ? (
                <div className="space-y-2">
                  <Label htmlFor="app-key" className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4" />
                    {credentialFieldLabel(selected.name, credentialField.label, selected.credentialFields.length)}
                  </Label>
                  <Input
                    id="app-key"
                    type="password"
                    value={credentialValue}
                    onChange={(event) => setCredentialValue(event.target.value)}
                    autoComplete="off"
                  />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">This app does not need a key.</p>
              )}

              {error ? <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error}</div> : null}

              <Button disabled={!canSubmit || connect.isPending} onClick={() => selected && connect.mutate(selected)}>
                {connect.isPending ? "Working..." : actionLabel}
              </Button>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No apps are available.</div>
          )}
        </div>
      </div>
    </div>
  );
}
