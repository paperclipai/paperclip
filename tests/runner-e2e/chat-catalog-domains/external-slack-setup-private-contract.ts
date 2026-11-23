export interface SlackSetupPrivateInput {
  endpointId: string;
  agentId: string;
  workspaceId: string;
  signingSecret: string;
}
export function validSlackSetupPrivate(
  companyId: unknown,
  input: SlackSetupPrivateInput | undefined,
  setupURL: string,
  repair = false,
) {
  try {
    const url = new URL(setupURL);
    return (
      typeof companyId === "string" &&
      /^[a-f0-9-]{36}$/i.test(companyId) &&
      !!input &&
      [input.endpointId, input.agentId].every((id) =>
        /^[a-f0-9-]{36}$/i.test(id),
      ) &&
      /^T[A-Z0-9]+$/.test(input.workspaceId) &&
      !!input.signingSecret &&
      input.signingSecret.length <= 8192 &&
      !/[\r\n]/.test(input.signingSecret) &&
      url.pathname.endsWith("/apps/chat/connect") &&
      url.searchParams.get("provider") === "slack" &&
      url.searchParams.get("purpose") === "chat" &&
      url.searchParams.get("resume") === input.endpointId &&
      url.searchParams.get("stage") === "credentials" &&
      (repair
        ? url.searchParams.size === 5 &&
          url.searchParams.get("reconnect") === "1"
        : url.searchParams.size === 4) &&
      !url.hash
    );
  } catch {
    return false;
  }
}
