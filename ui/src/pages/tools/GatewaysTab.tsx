import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, KeyRound, Link as LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toolsApi } from "@/api/tools";
import { ErrorState, LoadingState, RelativeTime, ToolsPageHeader } from "./shared";

function copyText(value: string) {
  void navigator.clipboard?.writeText(value);
}

export function GatewaysTab({ companyId }: { companyId: string }) {
  const gatewaysQuery = useQuery({
    queryKey: ["tools", "gateways", companyId],
    queryFn: () => toolsApi.listGateways(companyId),
  });

  const origin = useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.origin;
  }, []);

  if (gatewaysQuery.isLoading) return <LoadingState label="Loading gateways…" />;
  if (gatewaysQuery.isError) return <ErrorState error={gatewaysQuery.error} />;

  const gateways = gatewaysQuery.data?.gateways ?? [];

  return (
    <div className="space-y-5">
      <ToolsPageHeader
        title="Named MCP gateways"
        description="Stable endpoints for external clients that use the same profiles, rules, and audit trail as agent tool access."
      />

      {gateways.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-5 text-sm text-muted-foreground">
          No named gateways yet. Create one through the gateway API or a setup flow, then return here for endpoints and snippets.
        </div>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {gateways.map((gateway) => {
            const endpoint = `${origin}${gateway.endpointPath}`;
            return (
              <section key={gateway.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <LinkIcon className="h-4 w-4 text-muted-foreground" />
                      <h3 className="truncate text-sm font-semibold text-foreground">{gateway.name}</h3>
                      <span className="text-xs text-muted-foreground">{gateway.status}</span>
                    </div>
                    {gateway.description ? (
                      <p className="mt-1 text-sm text-muted-foreground">{gateway.description}</p>
                    ) : null}
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => copyText(endpoint)}>
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                    Copy endpoint
                  </Button>
                </div>

                <div className="break-all rounded bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
                  {endpoint}
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <KeyRound className="h-3.5 w-3.5" />
                      Tokens
                    </div>
                    <div className="space-y-1 text-sm">
                      {gateway.tokens.length === 0 ? (
                        <p className="text-muted-foreground">No tokens issued.</p>
                      ) : (
                        gateway.tokens.map((token) => (
                          <div key={token.id} className="flex items-center justify-between gap-3 py-1">
                            <span className="truncate text-foreground">{token.name}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {token.revokedAt ? "revoked" : token.expiresAt ? <>expires <RelativeTime value={token.expiresAt} /></> : "no expiry"}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="mb-1.5 text-xs font-medium text-muted-foreground">Client snippets</div>
                    <div className="space-y-1 text-sm">
                      {gateway.clientSnippets.slice(0, 3).map((snippet) => (
                        <button
                          key={snippet.client}
                          type="button"
                          className="flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-left hover:bg-accent"
                          onClick={() => copyText(JSON.stringify(snippet.config, null, 2))}
                        >
                          <span className="text-foreground">{snippet.label}</span>
                          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
