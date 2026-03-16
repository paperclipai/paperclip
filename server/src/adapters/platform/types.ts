/**
 * Type definitions for Platform Adapter
 */

export interface PlatformAgentConfig {
  // Platform adapter uses LLM provider configuration stored separately
  // No additional configuration needed at the adapter level
}

export interface LlmToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface AvailableTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}
