import { AppLogo } from "@/pages/apps/AppLogo";
import { ConnectionChoiceList } from "@/features/connections/ConnectionChoiceList";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AI_PROVIDERS,
  aiConnectionProblem,
  aiMethodLabel,
  bindingProblem,
  matchesAiRequirement,
  personalAiDefault,
  type AiConnectionBinding,
  type AiConnectionRequirement,
  type AiConnectionSummary,
} from "./model";

export interface AiConnectionPickerProps {
  requirement: AiConnectionRequirement;
  connections: AiConnectionSummary[];
  value?: AiConnectionBinding;
  currentUserId: string;
  agentId: string;
  agentName: string;
  loading?: boolean;
  error?: string;
  readOnly?: boolean;
  onChange: (binding: AiConnectionBinding) => void;
  onConnect: () => void;
  onRetry?: () => void;
}

export function AiConnectionPicker({
  requirement,
  connections,
  value,
  currentUserId,
  agentId,
  loading,
  error,
  readOnly,
  onChange,
  onConnect,
  onRetry,
}: AiConnectionPickerProps) {
  const compatible = connections.filter((connection) =>
    matchesAiRequirement(connection, requirement),
  );
  const personalDefault = personalAiDefault(
    connections,
    requirement,
    currentUserId,
  );
  const problem = value ? bindingProblem(
    value,
    requirement,
    connections,
    currentUserId,
    agentId,
  ) : undefined;
  const select = (
    mode: "shared",
    connection: AiConnectionSummary,
  ) =>
    onChange({
      provider: requirement.provider,
      method: connection.method,
      mode,
      connectionId: connection.id,
      grantId: connection.grantId,
    });
  return (
    <section className="flex flex-col gap-4" aria-label="AI connection">
      <div className="flex items-center gap-3">
        <AppLogo
          name={AI_PROVIDERS[requirement.provider].name}
          brandKey={requirement.provider}
          logoUrl={AI_PROVIDERS[requirement.provider].logo}
          darkLogoUrl={requirement.provider === "xai" ? "/brands/adapters/grok-dark.svg" : undefined}
          size={32}
        />
        <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-sm font-semibold">AI connection</h3>
        <p className="text-xs text-muted-foreground">
          {AI_PROVIDERS[requirement.provider].name}
          {value && value.mode !== "responsible_user" && ` · ${aiMethodLabel(value.provider, value.method)}`}
        </p>
        </div>
      </div>
      {loading ? (
        <div role="status" aria-label="Loading AI connections">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : error ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          {onRetry && (
            <Button type="button" variant="outline" onClick={onRetry}>
              Retry connections
            </Button>
          )}
        </div>
      ) : (
        <>
          <ConnectionChoiceList
            disabled={readOnly}
            selectedId={value?.mode === "responsible_user" ? "responsible_user" : value?.connectionId}
            choices={[
              { id: "responsible_user", name: "Responsible user’s connection", description: <>
                <span className="block">For you: {personalDefault?.name ?? "Not connected"}</span>
                <span className="block">Other users’ tasks use their own {AI_PROVIDERS[requirement.provider].name} connection.</span>
              </> },
              ...compatible.filter((connection) => connection.ownership === "shared").map((connection) => ({
                id: connection.id, name: connection.name,
                disabled: Boolean(aiConnectionProblem(connection)),
                description: <>Company shared · {aiMethodLabel(connection.provider, connection.method)}{connection.accountLabel ? ` · ${connection.accountLabel}` : ""}{aiConnectionProblem(connection) ? ` · ${aiConnectionProblem(connection)}` : ""}</>,
              })),
            ]}
            onSelect={(id) => {
              if (id === "responsible_user") onChange({provider: requirement.provider, method: personalDefault?.method ?? requirement.method ?? (requirement.provider === "openrouter" ? "api_key" : "subscription"), mode: "responsible_user"});
              else { const connection = compatible.find((item) => item.id === id)!; select("shared", connection); }
            }}
          />
          {problem && (
            <p role="status" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          {!readOnly && (
            <Button
              type="button"
              variant="outline"
              className="self-end"
              onClick={onConnect}
            >
              Connect another account
            </Button>
          )}
        </>
      )}
    </section>
  );
}
