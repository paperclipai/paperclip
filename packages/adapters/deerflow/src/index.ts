export const type = "deerflow";
export const label = "DeerFlow (LangGraph)";

export const models = [
  { id: "qwen3.5-9b", label: "Qwen3.5 9B (vLLM)" },
];

export const agentConfigurationDoc = `# deerflow agent configuration

Adapter: deerflow

Connects to a DeerFlow LangGraph server for agent execution with tools, sandboxes, memory, and skills.

Core fields:
- deerflowUrl (string, optional): LangGraph API base URL (default: http://deerflow-langgraph:2024)
- gatewayUrl (string, optional): Gateway API URL (default: http://deerflow-gateway:8001)
- model (string, optional): LLM model name (e.g., "claude-sonnet-4-6")
- skill (string, optional): DeerFlow skill to activate (e.g., "deep-research", "data-analysis")
- thinkingEnabled (boolean, optional): enable extended thinking (default: true)
- subagentEnabled (boolean, optional): enable sub-agent delegation (default: true)
- timeoutSec (number, optional): execution timeout in seconds (default: 600)
- recursionLimit (number, optional): LangGraph recursion limit (default: 100)
`;
