import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { queryKeys } from "@/lib/queryKeys";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import {
  useChatConnectorsEnabled,
  chatProviderVisible,
} from "@/hooks/useChatConnectorsEnabled";
import { Navigate, useParams, useSearchParams } from "@/lib/router";

function ProviderEndpointGate({
  endpointId,
  children,
}: {
  endpointId: string;
  children: ReactNode;
}) {
  const endpoint = useQuery({
    queryKey: queryKeys.chatEndpoints.detail(endpointId),
    queryFn: () => chatEndpointsApi.get(endpointId),
  });
  const endpointView = useQueryView(endpoint);
  const { enabled, githubEnabled } = useChatConnectorsEnabled();
  // A cached endpoint keeps gating the page through an outage; only a real
  // failure with nothing loaded shows the error.
  if (endpointView.kind === "error")
    return (
      <QueryErrorState
        size="page"
        className="p-6"
        error={endpoint.error}
        action="load this endpoint"
        onRetry={endpointView.retry}
        retrying={endpointView.isFetching}
      />
    );
  if (!endpoint.data) return null;
  return chatProviderVisible(endpoint.data.provider, enabled, githubEnabled) ? (
    <>{children}</>
  ) : (
    <Navigate to="/apps" replace />
  );
}

export function ChatConnectorsExperimentalGate({
  children,
}: {
  children: ReactNode;
}) {
  const { enabled, githubEnabled, loaded } = useChatConnectorsEnabled();
  const [params] = useSearchParams();
  const { endpointId } = useParams<{ endpointId: string }>();
  if (!endpointId && params.get("provider") === "agentmail")
    return <>{children}</>;
  if (!loaded) return null;
  if (endpointId)
    return (
      <ProviderEndpointGate endpointId={endpointId}>
        {children}
      </ProviderEndpointGate>
    );
  return chatProviderVisible(params.get("provider"), enabled, githubEnabled) ? (
    <>{children}</>
  ) : (
    <Navigate to="/apps" replace />
  );
}
