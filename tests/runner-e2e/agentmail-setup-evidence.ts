/** Independent browser + durable-state evidence, never the agent's claim. */
export function gradeAgentmailSetup(input: {
  interactions: Array<{ id: string; kind: string; status: string; addresseeUserId?: string | null; payload?: { serviceSlug?: string; purpose?: string; requestingAgentId?: string } }>;
  agentId: string;
  userId: string;
  visible: boolean;
  inputTypes: string[];
  keyLink: string | null;
  accessSelectorCount: number;
  dialogCount: number;
}) {
  const pending = input.interactions.filter(row => row.status === "pending");
  const card = pending[0];
  return [
    { id: "agentmail-durable-request", passed: pending.length === 1 && card?.kind === "connection_intent"
      && card.payload?.serviceSlug === "agentmail" && card.payload.purpose === "channel"
      && card.payload.requestingAgentId === input.agentId && card.addresseeUserId === input.userId,
      detail: "One saved AgentMail inbox request addresses the user for the requesting agent." },
    { id: "agentmail-inline-key-only", passed: input.visible && input.dialogCount === 0
      && input.inputTypes.length === 1 && input.inputTypes[0] === "password" && input.accessSelectorCount === 0,
      detail: "The thread shows one password field inline without an access step or modal." },
    { id: "agentmail-direct-key-link", passed: input.keyLink === "https://console.agentmail.to/dashboard/api-keys",
      detail: "Credential help opens the exact AgentMail API-key page." },
  ];
}
