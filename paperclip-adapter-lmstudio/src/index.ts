export const type = "lmstudio_local";
export const label = "LM Studio";
export const description = "Lokale LLMs via LM Studio (OpenAI-kompatibel)";

export const agentConfigurationDoc = `# LM Studio Adapter Konfiguration

## Felder

- **url** (string): LM Studio Server-URL. Default: \`http://localhost:1234\`
- **defaultModel** (string): Standard-Modell für alle Agents mit diesem Adapter.
- **model** (string, optional): Modell-Override pro Agent. Überschreibt defaultModel.
- **timeoutMs** (number): Timeout in Millisekunden. Default: \`120000\` (2 Minuten).
- **streamingEnabled** (boolean): Token-Streaming aktivieren. Default: \`true\`.
`;

export { createServerAdapter } from "./server/index.js";
