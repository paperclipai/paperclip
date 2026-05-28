import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { execute } from "./server/execute.js";
import { testEnvironment } from "./server/test.js";

export const type = "golem_knowledge";
export const label = "Golem XIV Knowledge";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# golem_knowledge agent configuration

Adapter: golem_knowledge

Use when:
- You want Paperclip to invoke Golem XIV as a knowledge broker agent.
- Golem XIV is running locally or on a reachable host.
- You want the agent to reason over your Neo4j knowledge graph via Golem's cognition API.

Don't use when:
- Golem XIV is not running or not reachable.
- You only need simple HTTP request/response without SSE streaming.

Core fields:
- url (string, required): Golem XIV server URL, e.g. http://localhost:8081
- authPassword (string, optional): HTTP session auth password (configured in Golem's httpAuth.password)
- timeoutSec (number, optional, default 120): Max seconds to wait for cognition to complete

How it works:
1. Adapter sends the agent wake text to Golem as a Text phenomenon via PUT /api/cognitions
2. Golem XIV reasons over the knowledge graph and streams events via GET /events SSE
3. Adapter collects TextUnfolding deltas and detects completion via ExpressionCulmination
4. Final accumulated text is returned to Paperclip as the agent run result

Notes:
- Golem XIV uses cookie-based session auth; the adapter handles login automatically
- The adapter streams events globally (GET /events) and filters by cognitionId
- Golem reasoning uses Claude Opus 4.6 with full Neo4j metacognition access
`;

/**
 * External adapter entry point for Paperclip's plugin loader.
 * Called by loadExternalAdapterPackage() via the adapter-plugin-store.
 */
export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    models,
    agentConfigurationDoc,
    supportsLocalAgentJwt: false,
  };
}

// Re-export server functions for direct import (builtin-style usage if needed)
export { execute, testEnvironment };
