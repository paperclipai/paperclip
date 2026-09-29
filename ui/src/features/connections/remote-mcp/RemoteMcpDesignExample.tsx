import { useState } from "react";
import { Button } from "@/components/ui/button";
import { remoteMcpProviders, type RemoteMcpProviderId } from "./providers";
import { RemoteMcpConnectionSetup } from "./RemoteMcpConnectionSetup";
import type { RemoteMcpSetupActions, RemoteMcpSetupState } from "./types";

function ConnectExample({ providerId }: { providerId: RemoteMcpProviderId }) {
  const provider = remoteMcpProviders[providerId];
  const [state, setState] = useState<RemoteMcpSetupState>({
    step: "access", grantKind: "organization", setupComplete: false, url: provider.defaultUrl,
    auth: provider.supportsBrowserAuth ? "auto" : "none", token: "", headers: [], advanced: false, connectStatus: "idle",
    connected: false, identity: null, allAgents: true, agentIds: [], permissions: {},
    tools: [], notice: null, refreshing: false,
  });
  const edit: RemoteMcpSetupActions["edit"] = (patch) => setState((value) => ({ ...value, ...patch }));
  const explain = () => edit({ notice: "Design example only. Review the interactive states in Storybook → Apps / Connections. No credentials are saved or sent." });
  const actions: RemoteMcpSetupActions = { edit, navigate: (step) => edit({ step }), connect: explain, cancelConnect: explain,
    openProvider: explain, saveExit: explain, resumeDraft: explain, finish: explain, refresh: explain, reconnect: explain, disconnect: explain,
  };
  return <RemoteMcpConnectionSetup connectionId="design-example" provider={provider} state={state} actions={actions} agents={[]} />;
}

/** Design-guide specimen; full state matrix is maintained in each provider's Storybook group. */
export function RemoteMcpDesignExample() {
  const [providerId, setProviderId] = useState<RemoteMcpProviderId>("zapier");
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2">{Object.values(remoteMcpProviders).map((provider) => <Button key={provider.id} size="sm" variant={providerId === provider.id ? "default" : "outline"} onClick={() => setProviderId(provider.id)}>{provider.name}</Button>)}</div>
    <ConnectExample key={providerId} providerId={providerId} />
  </div>;
}
