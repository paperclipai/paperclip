export const type = "lmstudio_local";
export const label = "LM Studio";
export const description = "Lokale LLMs via LM Studio (OpenAI-kompatibel)";

export const agentConfigurationDoc = `# LM Studio Adapter Konfiguration

## Felder

- **url** (string): Primary LM-Studio-URL. Default: \`http://localhost:1234\`
- **defaultModel** (string): Primary-Modell.
- **model** (string, optional): Modell-Override pro Agent.
- **fallbackUrl** (string, optional): Fallback LM-Studio-URL. Leer = kein Fallback.
- **fallbackModel** (string, optional): Fallback-Modellname. Leer = identisch mit defaultModel.
- **probeTimeoutMs** (number): Health-Probe-Timeout vor jedem Heartbeat. Default: \`2000\`.
- **timeoutMs** (number): Voller Call-Timeout. Default: \`120000\`.
- **streamingEnabled** (boolean): Token-Streaming. Default: \`true\`.
- **maxIterations** (number): Max Tool-Iterationen pro Heartbeat. Default: \`25\`.
- **maxRunSeconds** (number): Wallclock-Budget pro Run. Default: \`300\`.
`;

export { createServerAdapter } from "./server/index.js";
