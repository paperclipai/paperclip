import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { providerConnectionsApi, type ProviderName } from "@/api/providerConnections";
import { useCompany } from "@/context/CompanyContext";

function ProviderCard(props: {
  provider: ProviderName;
  title: string;
  connected: boolean;
  secretId: string | null;
  inputValue: string;
  onInputChange: (value: string) => void;
  onValidate: () => void;
  onSave: () => void;
  pending: boolean;
}) {
  const label = props.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{props.title}</h2>
        <span className={`text-xs ${props.connected ? "text-emerald-400" : "text-muted-foreground"}`}>
          {props.connected ? "Connected" : "Not connected"}
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        Store your {label} as an encrypted secret reference for this company.
      </p>
      {props.secretId && (
        <p className="mt-2 text-xs text-muted-foreground">
          Secret id: <code>{props.secretId}</code>
        </p>
      )}
      <input
        className="mt-4 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        type="password"
        value={props.inputValue}
        onChange={(event) => props.onInputChange(event.target.value)}
        placeholder={props.provider === "openai" ? "sk-..." : "sk-ant-..."}
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={props.onValidate} disabled={props.pending}>
          Validate
        </Button>
        <Button type="button" onClick={props.onSave} disabled={props.pending}>
          Save & Connect
        </Button>
      </div>
    </div>
  );
}

export function ConnectProvidersPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id ?? null;
  const [openAiKey, setOpenAiKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ["provider-connections", companyId],
    queryFn: () => providerConnectionsApi.getStatus(companyId as string),
    enabled: Boolean(companyId),
    retry: false,
  });

  const connectMutation = useMutation({
    mutationFn: (input: { provider: ProviderName; apiKey: string; validateOnly?: boolean }) =>
      providerConnectionsApi.connect(companyId as string, input),
    onSuccess: async (result) => {
      setMessage(result.message);
      await queryClient.invalidateQueries({ queryKey: ["provider-connections", companyId] });
    },
    onError: (error) => {
      setMessage(error instanceof Error ? error.message : "Failed to connect provider");
    },
  });

  if (!companyId) {
    return (
      <div className="mx-auto max-w-2xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">Connect Providers</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Select or create a company first, then return here to connect API providers.
          </p>
        </div>
      </div>
    );
  }

  const status = statusQuery.data;
  const pending = connectMutation.isPending;

  return (
    <div className="mx-auto max-w-3xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-2xl font-semibold">Connect providers</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Company: <span className="text-foreground">{selectedCompany?.name}</span>
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Add your Anthropic and OpenAI keys so agents can run immediately after invite acceptance.
        </p>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <ProviderCard
          provider="openai"
          title="OpenAI (Codex)"
          connected={Boolean(status?.openai.connected)}
          secretId={status?.openai.secretId ?? null}
          inputValue={openAiKey}
          onInputChange={setOpenAiKey}
          pending={pending}
          onValidate={() =>
            connectMutation.mutate({ provider: "openai", apiKey: openAiKey, validateOnly: true })
          }
          onSave={() => connectMutation.mutate({ provider: "openai", apiKey: openAiKey })}
        />
        <ProviderCard
          provider="anthropic"
          title="Anthropic (Claude)"
          connected={Boolean(status?.anthropic.connected)}
          secretId={status?.anthropic.secretId ?? null}
          inputValue={anthropicKey}
          onInputChange={setAnthropicKey}
          pending={pending}
          onValidate={() =>
            connectMutation.mutate({ provider: "anthropic", apiKey: anthropicKey, validateOnly: true })
          }
          onSave={() => connectMutation.mutate({ provider: "anthropic", apiKey: anthropicKey })}
        />
      </div>

      {message && (
        <div className="mt-4 rounded-md border border-border bg-card px-4 py-3 text-sm">
          {message}
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => statusQuery.refetch()}
          disabled={statusQuery.isFetching}
        >
          Refresh status
        </Button>
        <Button type="button" onClick={() => navigate(`/${selectedCompany?.issuePrefix}/dashboard`)}>
          Continue to dashboard
        </Button>
      </div>
    </div>
  );
}
