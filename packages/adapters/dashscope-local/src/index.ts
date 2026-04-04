export const type = "dashscope_local";
export const label = "阿里云百炼 (DashScope)";

export const models = [
  { id: "qwen-max", label: "Qwen Max" },
  { id: "qwen-plus", label: "Qwen Plus" },
  { id: "qwen-turbo", label: "Qwen Turbo" },
  { id: "qwen-long", label: "Qwen Long" },
  { id: "qwen3.5-plus", label: "Qwen 3.5 Plus" },
  { id: "qwen3-max", label: "Qwen 3 Max" },
  { id: "qwen-vl-max", label: "Qwen VL Max (多模态)" },
  { id: "qwen-vl-plus", label: "Qwen VL Plus (多模态)" },
  { id: "qwen-coder-plus", label: "Qwen Coder Plus (代码)" },
  { id: "qwen-coder-turbo", label: "Qwen Coder Turbo (代码)" },
  { id: "qwen-math-plus", label: "Qwen Math Plus (数学)" },
  { id: "qwen-math-turbo", label: "Qwen Math Turbo (数学)" },
];

export const agentConfigurationDoc = `# dashscope_local agent configuration

Adapter: dashscope_local

Use when:
- You want Paperclip to use Alibaba Cloud DashScope (百炼) models
- You have a DASHSCOPE_API_KEY configured
- You need Chinese-optimized LLM capabilities

Don't use when:
- You don't have DashScope API access
- You need local/offline inference

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process
- instructionsFilePath (string, optional): absolute path to a markdown instructions file
- model (string, required): DashScope model id (e.g., "qwen-max", "qwen-plus", "qwen-turbo")
- temperature (number, optional): sampling temperature (0.0-2.0, default 0.7)
- topP (number, optional): nucleus sampling threshold (0.0-1.0, default 0.8)
- maxTokens (number, optional): max completion tokens
- timeoutSec (number, optional): request timeout in seconds
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Requires DASHSCOPE_API_KEY environment variable
- API endpoint: https://coding.dashscope.aliyuncs.com/v1
- Models support: text generation, vision, code, math
- Billing: pay-per-token via Alibaba Cloud account
`;
