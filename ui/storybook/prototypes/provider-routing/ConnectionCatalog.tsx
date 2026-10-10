import { useState, type ComponentProps } from "react";
import {
  getAppStoreDefinition,
  APP_STORE_DEFINITIONS,
  aiProviderSetupPreset,
  type ToolConnection,
} from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AiProviderSetup } from "@/components/ai-connections/AiProviderSetup";
import { appDefinitionLogoUrl } from "@/pages/apps/app-definition-display";
import { ConnectorCard } from "@/pages/apps/Browse";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { providers, type Connection, type Provider } from "./model";

const date = new Date("2026-10-02T12:00:00Z");
export function asToolConnection(connection: Connection): ToolConnection {
  return {
    id: connection.id,
    uid: connection.id,
    companyId: "company-storybook",
    applicationId: `provider-routing-${connection.provider}`,
    name: connection.name,
    connectionKind: "managed",
    ownership: "customer",
    connectionPurpose: "ai",
    transport: "runtime_auth",
    authKind:
      connection.method === "Subscription"
        ? "oauth"
        : connection.method === "No authentication"
          ? "none"
          : "api_key",
    credentialSource: "paperclip_vault",
    credentialPolicy: connection.ownership === "shared" ? "shared" : "per_user",
    status: connection.status === "connected" ? "active" : "disabled",
    enabled: connection.status === "connected",
    transportConfig: {},
    config: { sourceTemplateKey: connection.provider },
    credentialSecretRefs: [],
    healthStatus: connection.status === "connected" ? "ok" : "error",
    healthCheckedAt: date,
    healthMessage: null,
    lastError: null,
    createdByAgentId: null,
    createdByUserId: "dotta",
    createdAt: date,
    updatedAt: date,
  };
}

/** Reuse the actual Connectors provider card, account rows, owner identity, status and menus. */
export function ConnectionCatalog({
  rows,
  onOpen,
  onAdd,
  onRemove,
  readOnly,
}: {
  rows: Connection[];
  onOpen: (connection: Connection) => void;
  onAdd: (provider: Provider) => void;
  onRemove: (id: string) => void;
  readOnly?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState<string>();
  const visible = providers.filter((provider) =>
    rows.some(
      (row) =>
        row.provider === provider.value &&
        `${provider.label} ${row.name} ${row.endpoint}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    ),
  );
  return (
    <div className="space-y-5">
      <Input
        type="search"
        aria-label="Search connectors"
        placeholder="Search connectors…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <section className="space-y-3" aria-label="Connector list">
        {visible.map((provider) => {
          const entry = getAppStoreDefinition(provider.value) ?? null;
          const row: ComponentProps<typeof ConnectorCard>["row"] = {
            key: provider.value,
            slug: provider.value,
            name: provider.label,
            description: provider.description,
            brandKey: provider.value,
            entry,
            logoUrl: appDefinitionLogoUrl(entry),
            connections: rows
              .filter((row) => row.provider === provider.value)
              .map(asToolConnection),
            chatEndpoints: [],
            applications: [
              {
                id: `provider-routing-${provider.value}`,
                companyId: "company-storybook",
                applicationKey: provider.value,
                name: provider.label,
                description: provider.description,
                type: "mcp_http",
                status: "active",
                pluginId: null,
                ownerAgentId: null,
                ownerUserId: "dotta",
                metadata: { sourceTemplateKey: provider.value },
                archivedAt: null,
                createdAt: date,
                updatedAt: date,
              },
            ],
          };
          return (
            <ConnectorCard
              key={provider.value}
              row={row}
              userProfileById={
                new Map([["dotta", { label: "Dotta", image: null }]])
              }
              chatConnectorsEnabled={false}
              renderAccountDetails={(toolConnection) => {
                const connection = rows.find(
                  (row) => row.id === toolConnection.id,
                )!;
                return (
                  <p className="text-xs text-muted-foreground">
                    {connection.ownership === "shared"
                      ? "Company account"
                      : "Personal account"}{" "}
                    · {connection.method}
                  </p>
                );
              }}
              onNavigate={(href) => {
                const connection = rows.find(
                  (row) => href === `/apps/${row.id}/permissions`,
                );
                if (connection) onOpen(connection);
                else if (!readOnly) onAdd(provider.value);
              }}
              onRequestRemove={(target) => {
                if (!readOnly) setRemoving(target.id);
              }}
            />
          );
        })}
      </section>
      {!visible.length && (
        <p className="text-sm text-muted-foreground">
          No connectors match “{query}”.
        </p>
      )}
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this connection?</DialogTitle>
            <DialogDescription>
              Agents using this connection will need another connection before
              their next run.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-between">
            <Button variant="ghost" onClick={() => setRemoving(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                onRemove(removing!);
                setRemoving(undefined);
              }}
            >
              Remove connection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Regular catalog rows and direct setup, using the production components. */
export function ProviderCatalogReview() {
  const [source, setSource] = useState<string>();
  const [query, setQuery] = useState("");
  const [client] = useState(() => {
    const value = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    value.setQueryData(["ai-connections", "company-storybook", undefined], { canManageConnections: true, connections: [] });
    value.setQueryData(["agents", "company-storybook", "provider-access"], [{ id: "nova", name: "Nova" }]);
    return value;
  });
  const preset = source ? aiProviderSetupPreset(source) : undefined;
  if (source) return <QueryClientProvider client={client}><AiProviderSetup
    companyId="company-storybook" initialProvider={preset?.provider ?? source as "openai" | "anthropic" | "xai"}
    initialProtocol={preset?.protocol} providerLabel={preset?.label}
    onCancel={() => setSource(undefined)} onComplete={() => setSource(undefined)}
  /></QueryClientProvider>;
  return <div className="space-y-5">
    <Input aria-label="Search connectors" placeholder="Search connectors…" value={query} onChange={event => setQuery(event.target.value)} />
    <div role="list" aria-label="Connector list" className="space-y-3">
      {APP_STORE_DEFINITIONS.filter(entry => entry.tags?.includes("model-provider") && `${entry.name} ${entry.description}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name)).map(entry => <ConnectorCard
        key={entry.slug}
        row={{ key: entry.slug, slug: entry.slug, name: entry.name, description: entry.description, brandKey: entry.slug, entry, logoUrl: entry.branding.logoUrl, darkLogoUrl: entry.branding.darkLogoUrl, applications: [], connections: [], chatEndpoints: [] }}
        userProfileById={new Map()} chatConnectorsEnabled={false}
        onNavigate={() => setSource(entry.slug)} onRequestRemove={() => {}}
      />)}
    </div>
  </div>;
}
