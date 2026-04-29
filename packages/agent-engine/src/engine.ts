import { createToolRegistry } from "./tool-registry.js";
import { buildSystemPrompt } from "./system-prompt.js";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "./tools/index.js";
import type {
  AgentEngine,
  AgentEngineConfig,
  SystemPromptConfig,
  ToolExecutionContext,
} from "./types.js";

/**
 * Create an agent engine with the built-in filesystem tools.
 *
 * Built-in tools:
 * - `read` — read file contents (text and images)
 * - `write` — write content to a file
 * - `edit` — edit a file with exact text replacement
 * - `bash` — execute bash commands
 * - `grep` — search file contents for patterns
 * - `find` — find files by glob pattern
 * - `ls` — list directory contents
 *
 * The engine is intentionally lightweight and transparent. It does not
 * include an LLM client or agent loop — those are provided by the adapter
 * or host that consumes the engine.
 */
export function createAgentEngine(config: AgentEngineConfig): AgentEngine {
  const registry = createToolRegistry();

  // Register built-in filesystem tools
  registry.register(createReadTool());
  registry.register(createWriteTool());
  registry.register(createEditTool());
  registry.register(createBashTool());
  registry.register(createGrepTool());
  registry.register(createFindTool());
  registry.register(createLsTool());

  const baseCtx: ToolExecutionContext = {
    cwd: config.cwd,
    env: config.env ?? {},
    agentId: undefined,
    runId: undefined,
    signal: undefined,
  };

  return {
    tools: registry,

    buildSystemPrompt(config: SystemPromptConfig): string {
      return buildSystemPrompt(config, registry);
    },

    async executeTool(
      name: string,
      params: unknown,
      ctx?: Partial<ToolExecutionContext>,
    ): Promise<unknown> {
      const tool = registry.get(name);
      if (!tool) {
        throw new Error(`Tool "${name}" is not registered.`);
      }

      const executionCtx: ToolExecutionContext = {
        ...baseCtx,
        ...ctx,
      };

      const timeoutMs = config.toolTimeoutMs ?? 60_000;
      const signal = executionCtx.signal;

      const result = await Promise.race([
        tool.execute(params, executionCtx),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Tool "${name}" timed out after ${timeoutMs}ms`));
          }, timeoutMs);

          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error(`Tool "${name}" was cancelled.`));
          });
        }),
      ]);

      // Apply max output size cap
      const maxBytes = config.maxToolOutputBytes ?? 50 * 1024;
      if (
        result !== null &&
        typeof result === "object" &&
        "content" in result &&
        typeof (result as Record<string, unknown>).content === "string"
      ) {
        const content = (result as { content: string }).content;
        if (content.length > maxBytes) {
          return {
            ...result,
            content: content.slice(0, maxBytes) + "\n[truncated]",
          };
        }
      }

      return result;
    },
  };
}
