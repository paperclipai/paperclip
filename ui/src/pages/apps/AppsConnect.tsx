import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { useQuery } from "@tanstack/react-query";
import { toolsApi } from "@/api/tools";
import { RemoteMcpProductionSetup } from "@/features/connections/remote-mcp/RemoteMcpProductionSetup";
import { useMcpAggregatorsEnabled } from "@/hooks/useMcpAggregatorsEnabled";
import { isRemoteMcpConnectorId, isRemoteMcpConnectorMethod } from "@paperclipai/shared";
import { useParams } from "@/lib/router";
import { useSearchParams } from "@/lib/router";
import type { ToolConnectionCredentialSource } from "@paperclipai/shared";

export {
  AccessStep,
  OAuthConnectStateScreen,
  type OAuthConnectPhase,
} from "@/features/connections/ConnectionSetupFlow";

/** Full-page host for the shared connection setup implementation. */
export function AppsConnect({
  byoOnly = false,
  credentialSource = "paperclip_vault",
}: {
  byoOnly?: boolean;
  credentialSource?: ToolConnectionCredentialSource;
} = {}) {
  const [searchParams] = useSearchParams();
  const aggregators = useMcpAggregatorsEnabled();
  const interactionId = searchParams.get("intent")?.trim() || undefined;
  const params = useParams<{ appKey?: string }>();
  const existingId = searchParams.get("resume") || searchParams.get("reconnect");
  const explicitSource = searchParams.get("source") || params.appKey || searchParams.get("appKey");
  // Ordinary connectors own their existing recovery/loading path. Only load
  // here when selecting an aggregator controller, or resolving an unknown source.
  const lookupExisting = !!existingId && (!explicitSource || isRemoteMcpConnectorId(explicitSource));
  const existing = useQuery({ queryKey: ["tools", "connection", existingId], queryFn: () => toolsApi.getConnection(existingId!), enabled: lookupExisting });
  const source = explicitSource || existing.data?.config?.sourceTemplateKey;
  const method = searchParams.get("method") || existing.data?.config?.connectionMethodKey;
  if (lookupExisting && existing.isPending) return <p className="p-8 text-sm text-muted-foreground">Loading connection…</p>;
  if (lookupExisting && existing.isError) return <div role="alert" className="space-y-3 p-8"><p>Could not load this connection. Your saved access and credentials have not changed.</p><button type="button" className="text-primary underline" onClick={() => void existing.refetch()}>Try again</button></div>;
  if (isRemoteMcpConnectorId(source) && (!method || isRemoteMcpConnectorMethod(source, method))) {
    if (!aggregators.loaded) return <p className="p-8 text-sm text-muted-foreground">Loading connection settings…</p>;
    if (!aggregators.enabled) return <p role="status" className="p-8 text-sm text-muted-foreground">Enable MCP aggregators in Settings → Experimental to set up this connection.</p>;
  }
  if (!byoOnly && !interactionId && credentialSource === "paperclip_vault" && isRemoteMcpConnectorId(source)
    && (!method || isRemoteMcpConnectorMethod(source, method))) {
    return <RemoteMcpProductionSetup key={existingId || source} providerId={source} connection={existing.data} />;
  }
  return (
    <ConnectionSetupFlow
      byoOnly={byoOnly}
      credentialSource={credentialSource}
      host="page"
      interactionId={interactionId}
    />
  );
}
