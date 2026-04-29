/**
 * Core types for the Paperclip Agent Engine.
 *
 * The agent engine provides a lightweight, transparent runtime for autonomous
 * agents with typed tool calling, system prompt management, and extensible
 * provider support.
 */

// ---------------------------------------------------------------------------
// Tool types
// ---------------------------------------------------------------------------

/**
 * JSON Schema shape for tool parameters.
 * Intentionally simple — adapters can stringify this for provider consumption.
 */
export interface ToolParameterSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
}

/**
 * A tool that the agent can invoke.
 */
export interface Tool<TParams = unknown, TResult = unknown> {
  /** Unique tool name (e.g. "read", "bash"). */
  name: string;

  /** Human-readable display name. */
  displayName: string;

  /** Description shown to the agent so it knows when and how to use the tool. */
  description: string;

  /** JSON Schema describing the tool's input parameters. */
  parametersSchema: ToolParameterSchema;

  /**
   * Execute the tool with the given parameters.
   *
   * @param params - Parsed parameters matching the schema
   * @param ctx - Execution context
   * @returns Tool result
   */
  execute(params: TParams, ctx: ToolExecutionContext): Promise<TResult>;
}

/**
 * Context passed to every tool execution.
 */
export interface ToolExecutionContext {
  /** The agent's configured working directory. */
  cwd: string;

  /** Additional environment variables. */
  env: Record<string, string>;

  /** Agent identifier. */
  agentId?: string;

  /** Run identifier. */
  runId?: string;

  /** Optional abort signal for cancellation. */
  signal?: AbortSignal;
}

/**
 * Standard result shape for tools that produce text output.
 */
export interface TextToolResult {
  /** The primary text content returned to the agent. */
  content: string;

  /** Whether the result represents an error. */
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Tool registry types
// ---------------------------------------------------------------------------

/**
 * A registry that stores and resolves tools by name.
 */
export interface ToolRegistry {
  /** Register a tool. Replaces any existing tool with the same name. */
  register(tool: Tool): void;

  /** Unregister a tool by name. */
  unregister(name: string): void;

  /** Look up a tool by name. */
  get(name: string): Tool | undefined;

  /** List all registered tools. */
  list(): Tool[];

  /** Check if a tool is registered. */
  has(name: string): boolean;

  /** Get the number of registered tools. */
  size(): number;
}

// ---------------------------------------------------------------------------
// System prompt types
// ---------------------------------------------------------------------------

/**
 * Builder for constructing system prompts that describe the agent's
 * identity, available tools, and operational rules.
 */
export interface SystemPromptBuilder {
  /** Add a section to the system prompt. */
  addSection(title: string, content: string): SystemPromptBuilder;

  /** Add a tool description section automatically derived from the registry. */
  addToolsSection(registry: ToolRegistry): SystemPromptBuilder;

  /** Build the final system prompt string. */
  build(): string;
}

/**
 * Configuration for system prompt generation.
 */
export interface SystemPromptConfig {
  /** The agent's role (e.g. "CTO", "Senior Engineer"). */
  role?: string;

  /** The agent's title or name. */
  title?: string;

  /** High-level mission statement. */
  mission?: string;

  /** Working directory for filesystem operations. */
  cwd?: string;

  /** Additional instruction sections. */
  sections?: Array<{ title: string; content: string }>;
}

// ---------------------------------------------------------------------------
// Engine types
// ---------------------------------------------------------------------------

/**
 * Configuration for the agent engine.
 */
export interface AgentEngineConfig {
  /** Working directory for the agent. */
  cwd: string;

  /** Environment variables. */
  env?: Record<string, string>;

  /** Timeout for individual tool executions (ms). */
  toolTimeoutMs?: number;

  /** Maximum output size for tool results (bytes). */
  maxToolOutputBytes?: number;
}

/**
 * The agent engine orchestrates tool registration, system prompt construction,
 * and tool execution for a single agent run.
 */
export interface AgentEngine {
  /** The tool registry. */
  readonly tools: ToolRegistry;

  /** Build a system prompt from config. */
  buildSystemPrompt(config: SystemPromptConfig): string;

  /** Execute a single tool by name with raw parameters. */
  executeTool(
    name: string,
    params: unknown,
    ctx?: Partial<ToolExecutionContext>,
  ): Promise<unknown>;
}
