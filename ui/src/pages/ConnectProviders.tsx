import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import {
  providerConnectionsApi,
  type ProviderCredential,
  type ProviderName,
} from "@/api/providerConnections";
import { queryKeys } from "@/lib/queryKeys";
import { useCompany } from "@/context/CompanyContext";

type CredentialDraft = {
  provider: string;
  envKey: string;
  label: string;
  apiKey: string;
  isDefault: boolean;
};

const KNOWN_PROVIDER_DEFAULTS: Array<{
  provider: string;
  title: string;
  envKey: string;
}> = [
  { provider: "openai", title: "OpenAI", envKey: "OPENAI_API_KEY" },
  { provider: "anthropic", title: "Anthropic", envKey: "ANTHROPIC_API_KEY" },
  { provider: "gemini", title: "Gemini", envKey: "GEMINI_API_KEY" },
  { provider: "google", title: "Google AI", envKey: "GOOGLE_API_KEY" },
  { provider: "cursor", title: "Cursor", envKey: "CURSOR_API_KEY" },
];

function titleForProvider(provider: string): string {
  const known = KNOWN_PROVIDER_DEFAULTS.find((item) => item.provider === provider);
  if (known) return known.title;
  return provider;
}

function defaultDraft(provider: string): CredentialDraft {
  const known = KNOWN_PROVIDER_DEFAULTS.find((item) => item.provider === provider);
  return {
    provider,
    envKey: known?.envKey ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`,
    label: "Default",
    apiKey: "",
    isDefault: true,
  };
}

function summarizeSecret(credential: ProviderCredential): string {
  return `${credential.secretName} (v${credential.secretLatestVersion})`;
}

export function ConnectProvidersPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id ?? null;
  const [message, setMessage] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, CredentialDraft>>({});
  const [customDraft, setCustomDraft] = useState<CredentialDraft>(() => ({
    provider: "",
    envKey: "",
    label: "Default",
    apiKey: "",
    isDefault: false,
  }));

  const statusQuery = useQuery({
    queryKey: companyId ? queryKeys.providerConnections.status(companyId) : ["provider-connections", "none"],
    queryFn: () => providerConnectionsApi.getStatus(companyId as string),
    enabled: Boolean(companyId),
    retry: false,
  });

  const createCredential = useMutation({
    mutationFn: (input: CredentialDraft) =>
      providerConnectionsApi.createCredential(companyId as string, {
        provider: input.provider,
        envKey: input.envKey,
        label: input.label,
        apiKey: input.apiKey,
        isDefault: input.isDefault,
      }),
    onSuccess: async () => {
      setMessage("Credential saved.");
      await queryClient.invalidateQueries({
        queryKey: queryKeys.providerConnections.status(companyId as string),
      });
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "Failed to save credential");
    },
  });

  const validateCredential = useMutation({
    mutationFn: (input: CredentialDraft) =>
      providerConnectionsApi.connect(companyId as string, {
        provider: input.provider as ProviderName,
        envKey: input.envKey,
        label: input.label,
        apiKey: input.apiKey,
        validateOnly: true,
        isDefault: input.isDefault,
      }),
    onSuccess: (result) => {
      setMessage(result.message);
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "Validation failed");
    },
  });

  const updateCredential = useMutation({
    mutationFn: (input: { id: string; label?: string; isDefault?: boolean }) =>
      providerConnectionsApi.updateCredential(companyId as string, input.id, {
        label: input.label,
        isDefault: input.isDefault,
      }),
    onSuccess: async () => {
      setMessage("Credential updated.");
      await queryClient.invalidateQueries({
        queryKey: queryKeys.providerConnections.status(companyId as string),
      });
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "Failed to update credential");
    },
  });

  const rotateCredential = useMutation({
    mutationFn: (input: { id: string; apiKey: string }) =>
      providerConnectionsApi.rotateCredential(companyId as string, input.id, {
        apiKey: input.apiKey,
      }),
    onSuccess: async () => {
      setMessage("Credential rotated.");
      await queryClient.invalidateQueries({
        queryKey: queryKeys.providerConnections.status(companyId as string),
      });
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "Failed to rotate credential");
    },
  });

  const deleteCredential = useMutation({
    mutationFn: (credentialId: string) =>
      providerConnectionsApi.deleteCredential(companyId as string, credentialId),
    onSuccess: async () => {
      setMessage("Credential deleted.");
      await queryClient.invalidateQueries({
        queryKey: queryKeys.providerConnections.status(companyId as string),
      });
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "Failed to delete credential");
    },
  });

  function draftFor(provider: string): CredentialDraft {
    return drafts[provider] ?? defaultDraft(provider);
  }

  function updateDraft(provider: string, patch: Partial<CredentialDraft>) {
    setDrafts((prev) => ({
      ...prev,
      [provider]: { ...draftFor(provider), ...patch, provider },
    }));
  }

  const allProviderIds = useMemo(() => {
    const knownIds = statusQuery.data?.knownProviders ?? KNOWN_PROVIDER_DEFAULTS.map((item) => item.provider);
    const fromCredentials = (statusQuery.data?.providers ?? []).map((item) => item.provider);
    return Array.from(new Set([...knownIds, ...fromCredentials])).sort((a, b) => a.localeCompare(b));
  }, [statusQuery.data]);

  const providerGroups = statusQuery.data?.providers ?? [];

  if (!companyId) {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">Manage credentials</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Select or create a company first, then return here to manage provider credentials.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl py-10 space-y-6">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-2xl font-semibold">Manage provider credentials</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Company: <span className="text-foreground">{selectedCompany?.name}</span>
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Add multiple keys per provider, set explicit defaults, and attach non-default keys per agent when needed.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {allProviderIds.map((provider) => {
          const group = providerGroups.find((item) => item.provider === provider) ?? null;
          const draft = draftFor(provider);
          const busy =
            createCredential.isPending ||
            validateCredential.isPending ||
            updateCredential.isPending ||
            rotateCredential.isPending ||
            deleteCredential.isPending;

          return (
            <div key={provider} className="rounded-lg border border-border bg-card p-5 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{titleForProvider(provider)}</h2>
                <span className="text-xs text-muted-foreground">
                  {group?.credentials.length ?? 0} key{(group?.credentials.length ?? 0) === 1 ? "" : "s"}
                </span>
              </div>

              <div className="space-y-2">
                {(group?.credentials ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">No credentials saved yet.</p>
                ) : (
                  group?.credentials.map((credential) => (
                    <div key={credential.id} className="rounded-md border border-border p-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="font-medium">
                            {credential.label}
                            {credential.isDefault ? " (default)" : ""}
                          </p>
                          <p className="text-muted-foreground">{credential.envKey}</p>
                          <p className="text-muted-foreground">{summarizeSecret(credential)}</p>
                        </div>
                        <div className="flex flex-col gap-1.5">
                          {!credential.isDefault && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-[11px]"
                              disabled={busy}
                              onClick={() => updateCredential.mutate({ id: credential.id, isDefault: true })}
                            >
                              Set default
                            </Button>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[11px]"
                            disabled={busy}
                            onClick={() => {
                              const nextLabel = window.prompt("New label", credential.label);
                              if (!nextLabel || !nextLabel.trim() || nextLabel === credential.label) return;
                              updateCredential.mutate({ id: credential.id, label: nextLabel.trim() });
                            }}
                          >
                            Relabel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[11px]"
                            disabled={busy}
                            onClick={() => {
                              const nextKey = window.prompt(`Rotate ${credential.label}: paste new API key`);
                              if (!nextKey || !nextKey.trim()) return;
                              rotateCredential.mutate({ id: credential.id, apiKey: nextKey.trim() });
                            }}
                          >
                            Rotate
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[11px]"
                            disabled={busy}
                            onClick={() => {
                              const confirmed = window.confirm(
                                `Delete credential '${credential.label}' for ${provider}?`,
                              );
                              if (!confirmed) return;
                              deleteCredential.mutate(credential.id);
                            }}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="rounded-md border border-border p-3 space-y-2">
                <p className="text-xs font-medium">Add credential</p>
                <input
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none"
                  value={draft.label}
                  onChange={(event) => updateDraft(provider, { label: event.target.value })}
                  placeholder="Label"
                />
                <input
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-mono outline-none"
                  value={draft.envKey}
                  onChange={(event) => updateDraft(provider, { envKey: event.target.value })}
                  placeholder="ENV key"
                />
                <input
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none"
                  type="password"
                  value={draft.apiKey}
                  onChange={(event) => updateDraft(provider, { apiKey: event.target.value })}
                  placeholder="API key"
                />
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={draft.isDefault}
                    onChange={(event) => updateDraft(provider, { isDefault: event.target.checked })}
                  />
                  Set as default
                </label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || !draft.apiKey.trim() || !draft.label.trim() || !draft.envKey.trim()}
                    onClick={() => validateCredential.mutate({ ...draft, provider })}
                  >
                    Validate
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || !draft.apiKey.trim() || !draft.label.trim() || !draft.envKey.trim()}
                    onClick={() =>
                      createCredential.mutate(
                        { ...draft, provider },
                        {
                          onSuccess: () => {
                            updateDraft(provider, { apiKey: "" });
                          },
                        },
                      )
                    }
                  >
                    Save
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <h2 className="text-base font-semibold">Custom provider</h2>
        <p className="text-xs text-muted-foreground">
          Use this for provider/model adapters when your provider is not listed above.
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          <input
            className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none"
            value={customDraft.provider}
            onChange={(event) => setCustomDraft((prev) => ({ ...prev, provider: event.target.value }))}
            placeholder="provider id (example: xai)"
          />
          <input
            className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-mono outline-none"
            value={customDraft.envKey}
            onChange={(event) => setCustomDraft((prev) => ({ ...prev, envKey: event.target.value }))}
            placeholder="env key (example: XAI_API_KEY)"
          />
          <input
            className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none"
            value={customDraft.label}
            onChange={(event) => setCustomDraft((prev) => ({ ...prev, label: event.target.value }))}
            placeholder="Label"
          />
          <input
            className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none"
            type="password"
            value={customDraft.apiKey}
            onChange={(event) => setCustomDraft((prev) => ({ ...prev, apiKey: event.target.value }))}
            placeholder="API key"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={customDraft.isDefault}
            onChange={(event) => setCustomDraft((prev) => ({ ...prev, isDefault: event.target.checked }))}
          />
          Set as default
        </label>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              !customDraft.provider.trim() ||
              !customDraft.envKey.trim() ||
              !customDraft.label.trim() ||
              !customDraft.apiKey.trim()
            }
            onClick={() =>
              validateCredential.mutate({
                ...customDraft,
                provider: customDraft.provider.trim(),
              })
            }
          >
            Validate
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={
              !customDraft.provider.trim() ||
              !customDraft.envKey.trim() ||
              !customDraft.label.trim() ||
              !customDraft.apiKey.trim()
            }
            onClick={() =>
              createCredential.mutate(
                {
                  ...customDraft,
                  provider: customDraft.provider.trim(),
                },
                {
                  onSuccess: () => {
                    setCustomDraft((prev) => ({ ...prev, apiKey: "" }));
                  },
                },
              )
            }
          >
            Save
          </Button>
        </div>
      </div>

      {message && (
        <div className="rounded-md border border-border bg-card px-4 py-3 text-sm">
          {message}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => statusQuery.refetch()}
          disabled={statusQuery.isFetching}
        >
          Refresh
        </Button>
        <Button
          type="button"
          onClick={() => navigate(`/${selectedCompany?.issuePrefix}/dashboard`)}
        >
          Back to dashboard
        </Button>
      </div>
    </div>
  );
}
