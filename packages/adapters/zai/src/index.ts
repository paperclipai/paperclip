export const type = "zai";
export const label = "Z.AI (GLM)";

// Text chat models only — Z.AI also ships vision / image-gen / video-gen /
// audio models (GLM-4.6V, GLM-Image, CogVideoX-3, GLM-ASR, etc.), but the
// Paperclip transcript UI has no rendering for image/video/audio output and
// no image-input path for agent context, so those are intentionally omitted.
// Users can still type any model id into the creatable ModelDropdown.
export const models: { id: string; label: string }[] = [
  { id: "glm-5.1", label: "GLM-5.1 (flagship, 200K ctx)" },
  { id: "glm-5", label: "GLM-5" },
  { id: "glm-5-turbo", label: "GLM-5 Turbo" },
  { id: "glm-4.7", label: "GLM-4.7" },
  { id: "glm-4.7-flashx", label: "GLM-4.7 FlashX" },
  { id: "glm-4.7-flash", label: "GLM-4.7 Flash" },
  { id: "glm-4.6", label: "GLM-4.6" },
  { id: "glm-4.5", label: "GLM-4.5" },
  { id: "glm-4.5-x", label: "GLM-4.5-X" },
  { id: "glm-4.5-air", label: "GLM-4.5 Air" },
  { id: "glm-4.5-airx", label: "GLM-4.5 AirX" },
  { id: "glm-4.5-flash", label: "GLM-4.5 Flash" },
  { id: "glm-4-32b-0414-128k", label: "GLM-4 32B (128K ctx)" },
];

export const DEFAULT_ZAI_MODEL = "glm-5.1";
export const DEFAULT_ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";

export const agentConfigurationDoc = `# zai adapter configuration

Adapter: zai

Use when:
- You want Paperclip agents to run against Z.AI's OpenAI-compatible API (GLM models).
- You need tool calling, streaming, or JSON-mode structured outputs from GLM.

Don't use when:
- You want to run a local subprocess-based coding agent (use claude_local, codex_local, etc).

Core fields:
- model (string, required): GLM model id (e.g. glm-5.1). See models list.
- apiKey (string, optional): Z.AI API key. Falls back to process.env.ZAI_API_KEY.
- baseUrl (string, optional): API base URL. Default: ${"https://api.z.ai/api/paas/v4"}.
- temperature (number, optional): sampling temperature.
- maxTokens (number, optional): max output tokens.
- timeoutMs (number, optional): request timeout in ms (default 60000).
- systemPrompt (string, optional): system prompt prepended to every request.
- stream (boolean, optional): enable SSE streaming (default true).
- responseFormat ("text" | "json_object", optional): force structured JSON output.
- tools (array, optional): OpenAI-format tool definitions. Tool calls from the
  model are emitted as transcript tool_call entries.
`;
