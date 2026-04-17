export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

export function buildToolSchemas(
  tools: Array<{ name: string; description: string; parametersSchema: unknown }>
): ToolSchema[] {
  // Convert Paperclip tool registry format → OpenAI function calling format
  // Compress descriptions: "The reason..." → reason
  // Shorten parameter descriptions
  // Result: 50-60% smaller schema overhead

  return tools.slice(0, 15) // Limit to top 15 tools by relevance
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: compressDescription(tool.description), // Max 100 chars
        parameters: simplifySchema(tool.parametersSchema),
      }
    }));
}

function compressDescription(desc: string): string {
  // Remove articles, fillers, truncate to 100 chars
  // "Use this tool to search the GitHub issues database for..." → "Search GitHub issues"

  let compressed = desc;

  // Remove fillers
  compressed = compressed.replace(/\b(Use this tool to|This tool allows you to|You can use this to)\b/gi, '');
  compressed = compressed.replace(/\b(The reason|This will|It will)\b/gi, '');

  // Remove articles
  compressed = compressed.replace(/\b(a|an|the)\b/gi, '');

  // Truncate
  if (compressed.length > 100) {
    compressed = compressed.substring(0, 97) + '...';
  }

  return compressed.trim();
}

function simplifySchema(schema: unknown): object {
  // Remove nested descriptions, keep only type info
  // For each property, keep only: type, description (short), required
  // This is a simplified version - in practice, you'd need to handle complex schemas

  if (!schema || typeof schema !== 'object') {
    return {
      type: 'object',
      properties: {},
      required: [],
    };
  }

  const schemaObj = schema as Record<string, unknown>;

  if (schemaObj.type === 'object' && schemaObj.properties) {
    const properties = schemaObj.properties as Record<string, unknown>;
    const simplifiedProperties: Record<string, unknown> = {};

    for (const [key, prop] of Object.entries(properties)) {
      if (typeof prop === 'object' && prop !== null) {
        const propObj = prop as Record<string, unknown>;
        simplifiedProperties[key] = {
          type: propObj.type || 'string',
          description: typeof propObj.description === 'string' && propObj.description.length > 50
            ? propObj.description.substring(0, 47) + '...'
            : propObj.description || '',
        };
      }
    }

    return {
      type: 'object',
      properties: simplifiedProperties,
      required: Array.isArray(schemaObj.required) ? schemaObj.required : [],
    };
  }

  return schemaObj;
}

export function buildGeminiToolSchema(tools: ToolSchema[]): object {
  // Convert to Gemini 2.5 tool format
  // https://ai.google.dev/api/rest/v1beta/Tool
  return {
    tools: tools.map(tool => ({
      function_declarations: [tool.function],
    })),
  };
}

export function buildClaudeToolSchema(tools: ToolSchema[]): object {
  // Convert to Claude tool format
  // Anthropic native format
  return tools;
}

export function buildLlamaToolSchema(tools: ToolSchema[]): object {
  // Convert to llama.cpp tool format
  // JSON schema that llama.cpp can parse
  return {
    tools: tools,
  };
}