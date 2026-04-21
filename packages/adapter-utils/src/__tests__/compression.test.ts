import { describe, it, expect } from "vitest";
import {
  compressPrompt,
  compressInstructions,
  compressWakeContext,
  compressBootstrapPrompt,
  compressEnvironmentNotes,
  compressApiNotes,
} from "../compression.js";

describe("Prompt Compression", () => {
  it("should reduce 50KB prompt to <10KB", () => {
    const fullPrompt = buildLargePrompt(); // 50KB
    const compressed = compressPrompt(fullPrompt);

    expect(compressed.original.length).toBeGreaterThan(40000);
    expect(compressed.compressed.length).toBeLessThan(10000);
    expect(compressed.reductionPercent).toBeGreaterThan(75);
  });

  it("should preserve critical task information", () => {
    const prompt = "Task: fix auth bug in UserService.ts. Critical: must handle expired tokens.";
    const { compressed } = compressPrompt(prompt);

    expect(compressed).toContain("auth");
    expect(compressed).toContain("UserService");
    expect(compressed).toContain("expired");
  });

  it("should remove conversational filler", () => {
    const prompt = "I'd be happy to help. Sure thing! Let me see... the reason is...";
    const { compressed } = compressPrompt(prompt);

    expect(compressed).not.toContain("I'd be happy");
    expect(compressed).not.toContain("Sure thing");
  });
});

describe("Caveman Formatting", () => {
  it("should reduce output tokens by 60-75%", () => {
    const verbose = "I'd be happy to help you. The reason this is happening is likely because...";
    const caveman = formatCaveman(verbose, { intensity: 'full' });

    const originalTokens = Math.ceil(verbose.length / 4);
    const cavemanTokens = Math.ceil(caveman.length / 4);
    const reduction = (1 - cavemanTokens / originalTokens) * 100;

    expect(reduction).toBeGreaterThan(50);
  });

  it("should preserve code blocks", () => {
    const text = `
      Here's the fix:
      \`\`\`python
      def auth_check(token):
          if token.expired:
              return False
      \`\`\`
      This validates tokens.
    `;
    const caveman = formatCaveman(text, { preserveCodeBlocks: true });

    expect(caveman).toContain("def auth_check");
    expect(caveman).toContain("token.expired");
  });
});

describe("Tool Schema Generation", () => {
  it("should convert 20 tools to <5KB schema", () => {
    const tools = generateMockTools(20);
    const schema = buildToolSchemas(tools);

    const json = JSON.stringify(schema);
    expect(json.length).toBeLessThan(5000);
  });

  it("should limit to top 15 tools", () => {
    const tools = generateMockTools(50);
    const schema = buildToolSchemas(tools);

    expect(schema).toHaveLength(15);
  });
});

describe("Context Windowing", () => {
  it("should trim conversation to context limit", () => {
    const turns = generateMockTurns(100, { tokensPerTurn: 100 });
    const limited = trimToContextWindow(turns, 8000);

    const totalTokens = limited.reduce((sum, t) => sum + t.tokens, 0);
    expect(totalTokens).toBeLessThanOrEqual(8000);
  });

  it("should keep recent turns unchanged", () => {
    const turns = generateMockTurns(10, { tokensPerTurn: 100 });
    const limited = trimToContextWindow(turns, 8000);

    // Last 3 turns should be unchanged
    expect(limited.slice(-3)).toEqual(turns.slice(-3));
  });
});

// Helper functions for tests
function buildLargePrompt(): string {
  // Create a large prompt for testing
  let prompt = "You are an AI assistant with extensive capabilities.\n";
  prompt += "I'd be happy to help you with various tasks.\n";
  prompt += "The reason you should use this system is because...\n";
  // Repeat to make it large
  while (prompt.length < 50000) {
    prompt += "Additional context and information that might be useful.\n";
  }
  return prompt;
}

function generateMockTools(count: number): Array<{ name: string; description: string; parametersSchema: unknown }> {
  const tools = [];
  for (let i = 0; i < count; i++) {
    tools.push({
      name: `tool_${i}`,
      description: `This is tool ${i} that does something useful for the task at hand.`,
      parametersSchema: {
        type: "object",
        properties: {
          param1: { type: "string", description: "A parameter for the tool" },
          param2: { type: "number", description: "Another parameter" },
        },
        required: ["param1"],
      },
    });
  }
  return tools;
}

function generateMockTurns(count: number, options: { tokensPerTurn: number }): ConversationTurn[] {
  const turns = [];
  for (let i = 0; i < count; i++) {
    turns.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i} with some content`,
      tokens: options.tokensPerTurn,
      timestamp: Date.now() + i * 1000,
    });
  }
  return turns;
}

// Import the missing functions
import { formatCaveman } from "../caveman-formatter.js";
import { buildToolSchemas } from "../tool-schema.js";
import { trimToContextWindow, ConversationTurn } from "../conversation-history.js";