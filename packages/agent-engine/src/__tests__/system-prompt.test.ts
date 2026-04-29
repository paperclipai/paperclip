import { describe, it, expect } from "vitest";
import { createSystemPromptBuilder, buildSystemPrompt } from "../system-prompt.js";
import { createToolRegistry } from "../tool-registry.js";

describe("createSystemPromptBuilder", () => {
  it("builds a prompt with sections", () => {
    const builder = createSystemPromptBuilder();
    builder.addSection("Identity", "You are a test agent.");
    builder.addSection("Rules", "Be helpful.");

    const prompt = builder.build();
    expect(prompt).toContain("# Identity");
    expect(prompt).toContain("You are a test agent.");
    expect(prompt).toContain("# Rules");
    expect(prompt).toContain("Be helpful.");
  });

  it("adds a tools section from registry", () => {
    const builder = createSystemPromptBuilder();
    const registry = createToolRegistry();
    registry.register({
      name: "test",
      displayName: "Test",
      description: "A test tool",
      parametersSchema: {
        type: "object",
        properties: {
          foo: { type: "string", description: "A foo param" },
        },
        required: ["foo"],
      },
      execute: async () => ({ content: "" }),
    });

    builder.addToolsSection(registry);
    const prompt = builder.build();
    expect(prompt).toContain("## test");
    expect(prompt).toContain("A test tool");
    expect(prompt).toContain("`foo`");
    expect(prompt).toContain("(required)");
  });

  it("handles empty registry", () => {
    const builder = createSystemPromptBuilder();
    builder.addToolsSection(createToolRegistry());
    const prompt = builder.build();
    expect(prompt).toContain("No tools are currently available.");
  });
});

describe("buildSystemPrompt", () => {
  it("includes identity and mission", () => {
    const prompt = buildSystemPrompt({
      role: "Engineer",
      title: "Tester",
      mission: "Write tests.",
    });

    expect(prompt).toContain("You are Engineer — Tester.");
    expect(prompt).toContain("Write tests.");
    expect(prompt).toContain("Operating Rules");
  });

  it("includes workspace when cwd is provided", () => {
    const prompt = buildSystemPrompt({ cwd: "/workspace" });
    expect(prompt).toContain("/workspace");
  });

  it("includes custom sections", () => {
    const prompt = buildSystemPrompt({
      sections: [{ title: "Custom", content: "Custom content." }],
    });
    expect(prompt).toContain("# Custom");
    expect(prompt).toContain("Custom content.");
  });
});
