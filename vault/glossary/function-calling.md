---
term: "Function calling"
definition: "Function calling is OpenAI's name for the LLM tool-use capability, introduced June 2023, where the model emits structured JSON describing a function to call and its arguments, conforming to a JSON Schema the developer supplies."
category: "agent runtime"
related_terms: [tool-use, mcp, agent-harness]
related_courses: [claude-tool-use-from-zero, picking-a-frontier-model-2026-q2]
sameAs:
  - https://en.wikipedia.org/wiki/Function_calling_(LLM)
  - https://platform.openai.com/docs/guides/function-calling
---

Function calling is functionally equivalent to Anthropic's tool use and Google Gemini's function declarations — the surface APIs differ but the protocol shape is identical. OpenAI's choice of the term "function calling" emphasizes the parallel with traditional programming, while Anthropic's "tool use" emphasizes the agent-runtime perspective.

Practical differences across vendors as of April 2026: OpenAI requires `strict: true` for guaranteed schema-compliant outputs (and in exchange, accepts a slightly restricted JSON Schema subset); Anthropic Claude accepts the full JSON Schema spec but does not provide a strict-mode guarantee; Google Gemini documents OpenAPI 3.0 schema, with similar guarantees to Anthropic.

For builders: the choice of vendor rarely depends on function-calling differences alone — model intelligence, latency, and cost dominate. But determinism in tool selection (which tool gets called for ambiguous inputs) and parameter accuracy (schema compliance) do vary; Koenig publishes monthly benchmark data at /data/claude-tool-use-determinism/.
