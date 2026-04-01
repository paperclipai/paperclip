import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { secretsApi } from "../api/secrets";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Key, Check, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import type { CompanySecret } from "@ironworksai/shared";

type ProviderKey = "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";

const PROVIDERS: { key: ProviderKey; label: string; placeholder: string; testUrl: string }[] = [
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    placeholder: "sk-ant-...",
    testUrl: "https://api.anthropic.com/v1/messages",
  },
  {
    key: "OPENAI_API_KEY",
    label: "OpenAI",
    placeholder: "sk-...",
    testUrl: "https://api.openai.com/v1/models",
  },
];

function maskKey(key: string): string {
  if (key.length < 12) return "****";
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

export function ApiKeyOnboardingBanner() {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [activeProvider, setActiveProvider] = useState<ProviderKey>("ANTHROPIC_API_KEY");
  const [keyValue, setKeyValue] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(selectedCompanyId ?? ""),
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const secrets = secretsQuery.data ?? [];
  const configuredKeys = new Set(
    secrets
      .filter((s: CompanySecret) =>
        s.name === "ANTHROPIC_API_KEY" || s.name === "OPENAI_API_KEY",
      )
      .map((s: CompanySecret) => s.name),
  );

  const hasAnyLlmKey = configuredKeys.has("ANTHROPIC_API_KEY") || configuredKeys.has("OPENAI_API_KEY");

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Validate the key first by attempting an API call
      setValidating(true);
      setValidationError(null);

      const provider = PROVIDERS.find((p) => p.key === activeProvider);
      if (!provider) throw new Error("Unknown provider");

      try {
        if (activeProvider === "ANTHROPIC_API_KEY") {
          const res = await fetch(provider.testUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": keyValue.trim(),
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 1,
              messages: [{ role: "user", content: "test" }],
            }),
          });
          // 200 or 400 (bad request due to minimal payload) both indicate the key is valid
          // 401 means invalid key
          if (res.status === 401) {
            throw new Error("Invalid API key - authentication failed");
          }
        } else {
          const res = await fetch(provider.testUrl, {
            headers: { Authorization: `Bearer ${keyValue.trim()}` },
          });
          if (res.status === 401) {
            throw new Error("Invalid API key - authentication failed");
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("Invalid API key")) {
          throw err;
        }
        // Network errors (CORS, etc.) are expected when calling external APIs from browser
        // The key will be validated server-side when actually used
      }

      // Save the key as a company secret
      const existingSecret = secrets.find((s: CompanySecret) => s.name === activeProvider);
      if (existingSecret) {
        await secretsApi.rotate(existingSecret.id, { value: keyValue.trim() });
      } else {
        await secretsApi.create(selectedCompanyId!, {
          name: activeProvider,
          value: keyValue.trim(),
          description: `${provider.label} API key for LLM access`,
        });
      }
    },
    onSuccess: () => {
      setValidating(false);
      setKeyValue("");
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId!) });
      pushToast({ title: "API key saved successfully" });
    },
    onError: (err) => {
      setValidating(false);
      setValidationError(err instanceof Error ? err.message : "Failed to save key");
    },
  });

  // Don't show banner if keys are already configured
  if (secretsQuery.isLoading) return null;
  if (hasAnyLlmKey && !expanded) {
    return null;
  }

  // If has keys and we got here through settings, show configured state
  if (hasAnyLlmKey) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Key className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">LLM API Keys</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>
        <div className="mt-2 flex gap-2">
          {PROVIDERS.map((p) => (
            <span
              key={p.key}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${
                configuredKeys.has(p.key)
                  ? "bg-green-500/10 text-green-600 dark:text-green-400"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {configuredKeys.has(p.key) && <Check className="h-3 w-3" />}
              {p.label}
            </span>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border-2 border-dashed border-amber-500/50 bg-amber-500/5 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
        <div className="flex-1">
          <h3 className="text-sm font-medium">Configure your LLM API key</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Your agents need an API key to communicate with LLM providers. Enter your Anthropic or OpenAI key to get started.
          </p>

          <div className="mt-3 flex gap-2">
            {PROVIDERS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => {
                  setActiveProvider(p.key);
                  setValidationError(null);
                }}
                className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                  activeProvider === p.key
                    ? "border-foreground bg-foreground/5 font-medium"
                    : "border-border hover:border-foreground/30"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="mt-3 flex gap-2">
            <input
              type="password"
              className="flex-1 rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 placeholder:text-muted-foreground/50"
              placeholder={PROVIDERS.find((p) => p.key === activeProvider)?.placeholder}
              value={keyValue}
              onChange={(e) => {
                setKeyValue(e.target.value);
                setValidationError(null);
              }}
            />
            <Button
              size="sm"
              disabled={!keyValue.trim() || saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? (validating ? "Validating..." : "Saving...") : "Save Key"}
            </Button>
          </div>

          {validationError && (
            <p className="mt-2 text-xs text-destructive">{validationError}</p>
          )}
        </div>
      </div>
    </div>
  );
}
