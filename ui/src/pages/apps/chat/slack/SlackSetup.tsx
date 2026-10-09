import { useQuery } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { OwnSlackAppSetup } from "./OwnSlackAppSetup";
import { ManagedSlackSetup } from "./ManagedSlackSetup";
export function SlackSetup(props: ComponentProps<typeof OwnSlackAppSetup>) {
  const choices = useQuery({ queryKey: ["slack-managed-workspaces", props.endpoint.companyId], queryFn: () => chatEndpointsApi.slackSetupOptions(props.endpoint.companyId), retry: false });
  return props.endpoint.setup?.slackSetupMethod === "managed"
    ? <ManagedSlackSetup {...props} onOwnApp={async () => props.onSaved(await chatEndpointsApi.update(props.endpoint.id, { slackSetupMethod: "automatic" }))} />
    : <OwnSlackAppSetup {...props} onManaged={choices.data?.managedAvailable && !props.endpoint.setup?.slackRegistration ? async () => props.onSaved(await chatEndpointsApi.update(props.endpoint.id, { slackSetupMethod: "managed" })) : undefined} />;
}
