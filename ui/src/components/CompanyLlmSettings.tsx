import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { companyLlmSettingsApi, llmModelsApi } from "../api";
import { Button } from "@/components/ui/button";
import { Field } from "./agent-config-primitives";
import { Zap } from "lucide-react";

interface CompanyLlmSettingsProps {
  companyId: string;
}

export function CompanyLlmSettings({ companyId }: CompanyLlmSettingsProps) {
  const queryClient = useQueryClient();
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");

  // Fetch company LLM settings
  const { data: settings } = useQuery({
    queryKey: ["company-llm-settings", companyId],
    queryFn: () => companyLlmSettingsApi.get(companyId),
  });

  // Fetch available providers
  const { data: providers = [] } = useQuery({
    queryKey: ["llm-providers"],
    queryFn: () => llmModelsApi.listProviders(),
  });

  // Fetch models for selected provider
  const { data: modelsResponse } = useQuery({
    queryKey: ["llm-models", selectedProvider],
    queryFn: () => llmModelsApi.listModels(selectedProvider),
    enabled: !!selectedProvider,
  });
  const models = modelsResponse?.models ?? [];

  // Sync settings to form
  useEffect(() => {
    if (settings) {
      setSelectedProvider(settings.preferredProviderType || "");
      setSelectedModel(settings.preferredModelId || "");
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: (data: { preferredProviderType: string; preferredModelId: string }) =>
      companyLlmSettingsApi.set(companyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company-llm-settings", companyId] });
    },
  });

  const handleSave = () => {
    if (selectedProvider && selectedModel) {
      saveMutation.mutate({
        preferredProviderType: selectedProvider,
        preferredModelId: selectedModel,
      });
    }
  };

  const isDirty =
    settings &&
    (selectedProvider !== (settings.preferredProviderType || "") ||
      selectedModel !== (settings.preferredModelId || ""));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Zap className="h-4 w-4 text-amber-600" />
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          LLM Provider
        </div>
      </div>
      <div className="space-y-3 rounded-md border border-border px-4 py-4">
        <Field label="Select provider" hint="Choose which LLM provider agents in this company will use by default.">
          <select
            value={selectedProvider}
            onChange={(e) => {
              setSelectedProvider(e.target.value);
              setSelectedModel("");
            }}
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
          >
            <option value="">Select a provider...</option>
            {providers.map((p) => (
              <option key={p.type} value={p.type}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        {selectedProvider && models.length > 0 && (
          <Field label="Select model" hint="Choose the model for this provider.">
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            >
              <option value="">Select a model...</option>
              {models.map((m: any) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id}
                </option>
              ))}
            </select>
          </Field>
        )}

        {selectedProvider && models.length === 0 && (
          <p className="text-sm text-muted-foreground">Loading models...</p>
        )}
      </div>

      {isDirty && (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending || !selectedProvider || !selectedModel}>
            {saveMutation.isPending ? "Saving..." : "Save LLM settings"}
          </Button>
          {saveMutation.isSuccess && <span className="text-xs text-green-600">Saved</span>}
          {saveMutation.isError && (
            <span className="text-xs text-destructive">Failed to save</span>
          )}
        </div>
      )}
    </div>
  );
}
