import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { useChatConnectorsEnabled } from "@/hooks/useChatConnectorsEnabled";
import { Navigate, useParams, useSearchParams } from "@/lib/router";

function DefaultEmailEndpointGate({ endpointId, children }: { endpointId: string; children: ReactNode }) {
  const endpoint = useQuery({
    queryKey: queryKeys.chatEndpoints.detail(endpointId),
    queryFn: () => chatEndpointsApi.get(endpointId),
  });
  if (endpoint.isError) return (
    <div className="space-y-3 p-6">
      <p role="alert" className="text-sm text-destructive">{endpoint.error.message}</p>
      <Button variant="outline" onClick={() => void endpoint.refetch()}>Retry</Button>
    </div>
  );
  if (!endpoint.data) return null;
  return endpoint.data.provider === "agentmail" ? <>{children}</> : <Navigate to="/apps" replace />;
}

export function ChatConnectorsExperimentalGate({
  children,
}: {
  children: ReactNode;
}) {
  const { enabled, loaded } = useChatConnectorsEnabled();
  const [params] = useSearchParams();
  const { endpointId } = useParams<{ endpointId: string }>();
  if (!endpointId && params.get("provider") === "agentmail") return <>{children}</>;
  if (!loaded) return null;
  if (!enabled) return endpointId
    ? <DefaultEmailEndpointGate endpointId={endpointId}>{children}</DefaultEmailEndpointGate>
    : <Navigate to="/apps" replace />;
  return <>{children}</>;
}
