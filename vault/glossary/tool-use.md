---
term: "Tool use"
definition: "Tool use is a capability where a large language model is given access to external functions (tools) it can invoke during inference, with the model deciding when to call which tool, generating structured arguments for the call, and incorporating the result into its subsequent generation."
category: "agent runtime"
related_terms: [function-calling, mcp, agent-harness]
related_courses: [claude-tool-use-from-zero, picking-a-frontier-model-2026-q2]
sameAs:
  - https://en.wikipedia.org/wiki/Function_calling_(LLM)
---

Tool use is implemented by all frontier model providers as of 2026: Anthropic Claude (`tools` parameter, `tool_use` content block), OpenAI (function calling, with JSON Schema), Google Gemini (function declarations). The wire formats differ slightly but the loop is identical — model generates a tool_use block, host application executes the tool, host returns the result as a tool_result message, model continues.

The reliability of tool use varies by model and prompt. Determinism (same input producing same output across runs) and parameter-schema correctness (the model fills the JSON schema correctly) are the two failure modes that matter most in production. Koenig AI Academy publishes a monthly determinism benchmark across the three frontier vendors at /data/claude-tool-use-determinism/.

Tool use predates MCP but is now usually combined with it: MCP provides the discovery + transport layer, while tool-use provides the model-level capability.
