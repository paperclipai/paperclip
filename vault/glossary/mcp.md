---
term: "Model Context Protocol (MCP)"
definition: "Model Context Protocol (MCP) is an open standard introduced by Anthropic in November 2024 for connecting AI assistants to data sources and tools through a JSON-RPC wire protocol over stdio or HTTP transports."
category: "protocol"
related_terms: [tool-use, function-calling, agent-harness, rag]
related_courses: [mcp-from-first-principles-to-production, claude-tool-use-from-zero, production-agents-claude-agent-sdk-mcp-connector]
sameAs:
  - https://en.wikipedia.org/wiki/Model_Context_Protocol
  - https://www.wikidata.org/wiki/Q125534478
  - https://spec.modelcontextprotocol.io/
---

MCP standardizes how AI applications connect to external context — replacing N×M custom integrations between models and tools with a single protocol. The 2025-11-25 specification defines three primitives: Tools (callable functions), Resources (read-only context), and Prompts (parameterized templates). The 2026 roadmap commits to OAuth 2.1, DPoP token binding, audit logging, and Gateway-tier scalability.

The protocol's core design choice — JSON-RPC over stdio for local servers, plus HTTP+SSE for remote — was deliberate: it favors discoverability and stream-based context delivery over request-response simplicity, and it lets MCP servers run as ordinary processes that any host application can spawn.

Major adopters as of April 2026 include Anthropic Claude (native), OpenAI (via Connectors), Google Gemini Enterprise (Vertex Agent Platform), Cursor, and the Zed editor. The MCP registry at modelcontextprotocol.io lists 200+ community servers.
