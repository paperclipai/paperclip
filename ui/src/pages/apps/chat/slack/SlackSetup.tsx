import { useQuery } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { OwnSlackAppSetup } from "./OwnSlackAppSetup";
import { ManagedSlackSetup } from "./ManagedSlackSetup";
export function SlackSetup(props: ComponentProps<typeof OwnSlackAppSetup> & { autoStart?: boolean; reconnect?: boolean }) {
  const choices = useQuery({ queryKey: ["slack-managed-workspaces", props.endpoint.companyId], queryFn: () => chatEndpointsApi.slackSetupOptions(props.endpoint.companyId), retry: false });
  return props.endpoint.setup?.slackSetupMethod === "managed"
    ? <ManagedSlackSetup {...props} />
    : <OwnSlackAppSetup {...props} onManaged={choices.data?.defaultMethod === "managed" && !props.endpoint.setup?.slackRegistration ? async () => props.onSaved(await chatEndpointsApi.update(props.endpoint.id, { slackSetupMethod: "managed" })) : undefined} />;
}
