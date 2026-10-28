import { aiConnectionsApi } from "@/api/ai-connections";
import type { AiProvider } from "@paperclipai/shared";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import { secretsApi } from "@/api/secrets";
import { queryKeys } from "@/lib/queryKeys";
import {
  savedProviderKeys,
  savedManagedProviderAccounts,
  savedCodexSubscriptions,
  type SavedProviderKey,
} from "@/lib/saved-provider-credentials";

export function useSavedProviderKeys(
  companyId: string | null,
  envKey: string,
  enabled = true,
) {
  const provider = ({ ANTHROPIC_API_KEY: "anthropic", OPENAI_API_KEY: "openai", OPENROUTER_API_KEY: "openrouter", XAI_API_KEY: "xai" } as Record<string, AiProvider>)[envKey];
  const managed = useQuery({
    queryKey: ["ai-connections", companyId],
    queryFn: () => aiConnectionsApi.list(companyId!),
    enabled: Boolean(companyId && provider) && enabled,
    retry: false,
  });
  const managedAccounts = provider && managed.data ? savedManagedProviderAccounts(companyId!, provider, managed.data.currentUserId, managed.data.connections) : [];
  const personal = useQuery({
    queryKey: queryKeys.secrets.myUserSecrets(companyId ?? ""),
    queryFn: () => secretsApi.listMyUserSecrets(companyId!),
    enabled: Boolean(companyId) && enabled,
    retry: false,
  });
  const organization = useQuery({
    queryKey: queryKeys.secrets.list(companyId ?? ""),
    queryFn: () => secretsApi.list(companyId!),
    enabled: Boolean(companyId) && enabled,
    retry: false,
  });
  const storedLogin = useQuery({
    // Disabled queries still return cached data. Keep other providers away
    // from the shared Claude login cache.
    queryKey: ["claude-oauth-token-status", envKey === "ANTHROPIC_API_KEY" ? companyId : null],
    queryFn: async () => {
      try {
        return await agentsApi.getClaudeOAuthTokenStatus(companyId!);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: Boolean(companyId) && enabled && envKey === "ANTHROPIC_API_KEY",
    retry: false,
  });
  return {
    storedLogin,
    options: [...managedAccounts.filter(account => account.aiConnection?.method === "api_key"), ...savedProviderKeys(
      companyId ?? "",
      envKey,
      personal.data ?? [],
      organization.data ?? [],
    )],
    subscriptions: [...managedAccounts.filter(account => account.aiConnection?.method === "subscription"), ...(provider === "openai" ? savedCodexSubscriptions(
      companyId ?? "",
      organization.data ?? [],
    ) : [])],
    // Background refreshes must not unmount an active login panel sharing this query.
    loading: personal.isLoading || organization.isLoading || storedLogin.isLoading || managed.isLoading,
    error: personal.isError || organization.isError || managed.isError,
  };
}

export function SavedProviderKeySelect({
  options,
  value,
  onChange,
  loading,
  error,
  disabled,
  kind = "api",
}: {
  options: SavedProviderKey[];
  value: string;
  onChange: (id: string) => void;
  loading: boolean;
  error: boolean;
  disabled?: boolean;
  kind?: "api" | "subscription";
}) {
  return (
    <div className="space-y-2">
      {options.length > 0 && (
        <label className="block space-y-2 text-sm">
          <span>{kind === "api" ? "API key" : "Subscription"}</span>
          <select
            aria-label={kind === "api" ? "Saved API key" : "Saved subscription"}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
            <option value="">
              {kind === "api"
                ? "Enter a new API key"
                : "Sign in to another account"}
            </option>
          </select>
        </label>
      )}
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Checking saved API keys…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          Some saved keys could not be loaded. You can still enter a new key.
        </p>
      )}
      {value && (
        <p className="text-sm text-muted-foreground">
          Reuse this saved {kind === "api" ? "key" : "subscription"} for this
          agent.
        </p>
      )}
    </div>
  );
}
