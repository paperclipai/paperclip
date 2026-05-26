import { useEffect, useState } from "react";
import { Loader2, MessageSquare, Save } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { companyAwaitingHumanSettingsApi } from "@/api/companyAwaitingHumanSettings";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Field, ToggleField } from "@/components/agent-config-primitives";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type AwaitingHumanProviderValue = "none" | "clickup";

export function CompanyAwaitingHumanSettings() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.companies.awaitingHumanSettings(selectedCompanyId) : ["companies", "none", "awaiting-human-settings"],
    queryFn: () => companyAwaitingHumanSettingsApi.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const [bridgeEnabled, setBridgeEnabled] = useState(false);
  const [provider, setProvider] = useState<AwaitingHumanProviderValue>("none");
  const [personalToken, setPersonalToken] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [channelId, setChannelId] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Awaiting Human" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  useEffect(() => {
    const settings = settingsQuery.data;
    if (!settings) return;
    setBridgeEnabled(settings.enabled);
    setProvider(settings.provider ?? "none");
    setPersonalToken("");
    setWorkspaceId(settings.providerConfig?.workspaceId ?? "");
    setChannelId(settings.providerConfig?.channelId ?? "");
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const company = selectedCompany;
      if (!company) {
        throw new Error("No company selected");
      }
      return companyAwaitingHumanSettingsApi.update(selectedCompanyId!, {
        enabled: bridgeEnabled && provider !== "none",
        provider: provider === "none" ? null : "clickup",
        providerConfig: provider === "clickup"
          ? {
            workspaceId: workspaceId.trim() || null,
            channelId: channelId.trim() || null,
          }
          : null,
        clickupPersonalToken: provider === "clickup" ? (personalToken.trim() || null) : null,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.awaitingHumanSettings(selectedCompanyId!) });
      setPersonalToken("");
    },
  });

  if (!selectedCompany || !selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company before editing awaiting-human settings.
      </div>
    );
  }

  if (settingsQuery.isLoading) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card px-6 py-5 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-sky-600" />
        Loading awaiting-human settings…
      </div>
    );
  }

  if (settingsQuery.isError) {
    return (
      <div className="space-y-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-foreground">
        <div className="font-semibold text-destructive">Failed to load awaiting-human settings</div>
        <div className="text-muted-foreground">
          {settingsQuery.error instanceof Error ? settingsQuery.error.message : "Please try again."}
        </div>
        <Button size="sm" variant="outline" onClick={() => settingsQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const settings = settingsQuery.data;
  const normalizedProvider = provider === "none" ? null : "clickup";
  const isDirty =
    bridgeEnabled !== (settings?.enabled ?? false)
    || normalizedProvider !== (settings?.provider ?? null)
    || personalToken.trim().length > 0
    || workspaceId !== (settings?.providerConfig?.workspaceId ?? "")
    || channelId !== (settings?.providerConfig?.channelId ?? "");
  const providerEnabled = provider !== "none";
  const hasStoredClickUpToken = settings?.hasStoredAuthToken ?? false;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="rounded-2xl border border-border/70 bg-card p-6">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-sky-500/10 p-2 text-sky-700 dark:text-sky-300">
            <MessageSquare className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold text-foreground">Awaiting Human</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Configure the company-wide awaiting-human bridge and choose which transport adapter
              handles outbound messages and reply polling.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Bridge policy</h2>
          <p className="text-sm text-muted-foreground">
            This controls the generic awaiting-human bridge for the company. Provider credentials
            and instance-level transport secrets still live outside this page.
          </p>
        </div>

        <ToggleField
          label="Enable awaiting-human bridge"
          hint="When enabled, Bizbox uses the configured company bridge for awaiting-human delivery and polling."
          checked={bridgeEnabled}
          onChange={setBridgeEnabled}
          toggleTestId="awaiting-human-bridge-enabled-toggle"
        />

        <Field
          label="Transport adapter"
          hint="Select the provider adapter Bizbox should use for awaiting-human threads for this company."
        >
          <Select
            value={provider}
            onValueChange={(value) => setProvider(value as AwaitingHumanProviderValue)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose adapter" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Disabled</SelectItem>
              <SelectItem value="clickup">ClickUp</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {provider === "clickup" ? (
          <div className="space-y-4 rounded-xl border border-border/70 bg-muted/20 p-4">
            <div className="space-y-1">
              <h3 className="text-sm font-semibold text-foreground">ClickUp adapter</h3>
              <p className="text-sm text-muted-foreground">
                Provider-specific routing for the ClickUp awaiting-human transport. Leave the
                channel ID blank to use the instance-level ClickUp default.
              </p>
            </div>

            <Field
              label="Personal token"
              hint="Stored as a company secret. Leave blank to keep the currently saved ClickUp token."
            >
              <input
                type="password"
                value={personalToken}
                onChange={(e) => setPersonalToken(e.target.value)}
                disabled={!providerEnabled}
                placeholder={hasStoredClickUpToken ? "Stored token configured" : "Paste ClickUp personal token"}
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </Field>

            {hasStoredClickUpToken ? (
              <div className="text-xs text-muted-foreground">
                A ClickUp token is already stored for this company. Enter a new value to rotate it.
              </div>
            ) : null}

            <Field
              label="Workspace ID"
              hint="Deterministic ClickUp workspace target. Derived from the leading numeric segment in the ClickUp chat URL."
            >
              <input
                type="text"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                disabled={!providerEnabled}
                placeholder="90161423646"
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </Field>

            <Field
              label="Channel ID"
              hint="Deterministic ClickUp target. If set, Bizbox sends awaiting-human messages directly to this chat channel."
            >
              <input
                type="text"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                disabled={!providerEnabled}
                placeholder="chat-channel-id"
                className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
            </Field>
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={!isDirty || saveMutation.isPending}
          >
            <Save className="mr-1.5 h-4 w-4" />
            {saveMutation.isPending ? "Saving..." : "Save awaiting-human settings"}
          </Button>
          {saveMutation.isSuccess ? (
            <span className="text-xs text-muted-foreground">Saved</span>
          ) : null}
          {saveMutation.isError ? (
            <span className="text-xs text-destructive">
              {saveMutation.error instanceof Error ? saveMutation.error.message : "Failed to save"}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
