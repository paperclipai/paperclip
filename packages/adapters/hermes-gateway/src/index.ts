export const type = "hermes_gateway";
export const label = "Hermes Gateway";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# hermes_gateway agent configuration

Adapter: hermes_gateway

Use when:
- You want Paperclip to connect to a standalone Hermes Agent running on the network (e.g. Railway)

Core fields:
- url (string, required): Hermes agent API URL (e.g., http://hermes-agent.railway.internal:8080/v1/chat/completions)
- apiKey (string, optional): Auth key setup in Hermes
`;
