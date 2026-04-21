export interface ToolExecution {
  toolName: string;
  parameters: Record<string, unknown>;
  result: string | null;
  error: string | null;
  duration: number;
}

export async function executeToolCall(
  toolCall: { name: string; input: Record<string, unknown> },
  toolRegistry: ToolRegistry, // From plugin-tool-registry
  context: ToolRunContext
): Promise<ToolExecution> {
  const startTime = Date.now();

  try {
    const result = await toolRegistry.executeTool(
      toolCall.name,
      toolCall.input,
      context
    );

    return {
      toolName: toolCall.name,
      parameters: toolCall.input,
      result: result.content ?? null,
      error: null,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      toolName: toolCall.name,
      parameters: toolCall.input,
      result: null,
      error: err instanceof Error ? err.message : String(err),
      duration: Date.now() - startTime,
    };
  }
}

// Placeholder types - these would come from the actual tool registry
interface ToolRegistry {
  executeTool(name: string, input: Record<string, unknown>, context: ToolRunContext): Promise<{ content: string }>;
}

interface ToolRunContext {
  // Context for tool execution
}