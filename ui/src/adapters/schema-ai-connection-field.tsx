import { useQuery } from "@tanstack/react-query";
import type { ConfigFieldSchema } from "@paperclipai/adapter-utils";
import {
  aiConnectionFieldBindingFor,
  aiConnectionMatchesField,
  parseAiConnectionFieldBinding,
  readAiConnectionFieldMeta,
  type AiConnectionFieldMeta,
  type AiManagedConnectionSummary,
} from "@paperclipai/shared";
import { aiConnectionsApi } from "../api/ai-connections";
import { useCompany } from "../context/CompanyContext";
import { Field } from "../components/agent-config-primitives";
import { aiMethodLabel } from "../components/ai-connections/model";

const selectClass =
  "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none";

export function isSchemaAiConnectionField(field: ConfigFieldSchema): boolean {
  return readAiConnectionFieldMeta(field.meta) !== null;
}

export function aiConnectionKindLabel(connection: AiManagedConnectionSummary): string {
  if (connection.routing) {
    const route = connection.routing;
    if (route.kind === "gateway" || route.kind === "local") return `Gateway · ${route.baseUrl ?? ""}`.trim();
    return route.kind === "openrouter" ? "OpenRouter" : "Bedrock";
  }
  return aiMethodLabel(connection.provider, connection.method);
}

export function compatibleAiConnections(
  connections: AiManagedConnectionSummary[],
  meta: AiConnectionFieldMeta,
): AiManagedConnectionSummary[] {
  return connections.filter((connection) => aiConnectionMatchesField(meta, connection));
}

function optionValue(connection: Pick<AiManagedConnectionSummary, "id" | "grantId">): string {
  return `${connection.id}:${connection.grantId}`;
}

export function SchemaAiConnectionField({
  field,
  value,
  onChange,
}: {
  field: ConfigFieldSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { selectedCompanyId } = useCompany();
  const meta = readAiConnectionFieldMeta(field.meta);
  const binding = parseAiConnectionFieldBinding(value);
  const accounts = useQuery({
    queryKey: ["ai-connections", selectedCompanyId],
    queryFn: () => aiConnectionsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && meta),
  });
  if (!meta) return null;
  const options = compatibleAiConnections(accounts.data?.connections ?? [], meta);
  const selected = binding
    ? options.find((connection) => connection.id === binding.connectionId && connection.grantId === binding.grantId)
    : undefined;
  const missing = Boolean(binding) && !selected && accounts.isSuccess;

  return (
    <Field label={field.label} hint={field.hint}>
      <div className="space-y-1.5">
        <select
          className={selectClass}
          aria-label={field.label}
          value={binding ? `${binding.connectionId}:${binding.grantId}` : ""}
          onChange={(event) => {
            const next = options.find((connection) => optionValue(connection) === event.target.value);
            onChange(next ? aiConnectionFieldBindingFor(next) : undefined);
          }}
        >
          <option value="">{accounts.isLoading ? "Loading connections..." : "No connection"}</option>
          {missing && binding ? <option value={`${binding.connectionId}:${binding.grantId}`}>Unavailable connection</option> : null}
          {options.map((connection) => (
            <option key={optionValue(connection)} value={optionValue(connection)}>
              {connection.name} · {aiConnectionKindLabel(connection)}
              {connection.status === "connected" ? "" : " (needs attention)"}
            </option>
          ))}
        </select>
        {accounts.isError ? (
          <p className="text-xs text-destructive">AI connections could not be loaded.</p>
        ) : missing ? (
          <p className="text-xs text-destructive">
            The selected connection is no longer available or compatible. Choose another or clear it.
          </p>
        ) : accounts.isSuccess && options.length === 0 ? (
          <p className="text-xs text-muted-foreground">No compatible AI connections yet. Add one in company settings.</p>
        ) : null}
      </div>
    </Field>
  );
}
