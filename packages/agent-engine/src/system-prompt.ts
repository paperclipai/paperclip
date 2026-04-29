import type { SystemPromptBuilder, SystemPromptConfig, ToolRegistry } from "./types.js";

/**
 * Create a system prompt builder with sensible defaults for Paperclip agents.
 */
export function createSystemPromptBuilder(): SystemPromptBuilder {
  const sections: Array<{ title: string; content: string }> = [];

  return {
    addSection(title: string, content: string): SystemPromptBuilder {
      sections.push({ title, content });
      return this;
    },

    addToolsSection(registry: ToolRegistry): SystemPromptBuilder {
      const toolList = registry.list();
      if (toolList.length === 0) {
        sections.push({ title: "Tools", content: "No tools are currently available." });
        return this;
      }

      const lines: string[] = [
        "You have access to the following tools. Use them precisely and responsibly.",
        "",
      ];

      for (const tool of toolList) {
        lines.push(`## ${tool.name}`);
        lines.push(tool.description);
        lines.push("");

        const schema = tool.parametersSchema;
        if (schema.properties && Object.keys(schema.properties).length > 0) {
          lines.push("**Parameters:**");
          for (const [key, value] of Object.entries(schema.properties)) {
            const required = schema.required?.includes(key) ? " (required)" : "";
            const desc =
              typeof value === "object" && value !== null && "description" in value
                ? String((value as Record<string, unknown>).description)
                : "";
            lines.push(`- \`${key}\`${required}: ${desc}`);
          }
          lines.push("");
        }
      }

      sections.push({ title: "Tools", content: lines.join("\n") });
      return this;
    },

    build(): string {
      const parts: string[] = [];

      for (const section of sections) {
        parts.push(`# ${section.title}`);
        parts.push("");
        parts.push(section.content.trim());
        parts.push("");
      }

      return parts.join("\n").trim();
    },
  };
}

/**
 * Build a standard Paperclip system prompt from config.
 *
 * This produces a prompt that includes identity, mission, operational rules,
 * and a dynamically-generated tool reference.
 */
export function buildSystemPrompt(
  config: SystemPromptConfig,
  registry?: ToolRegistry,
): string {
  const builder = createSystemPromptBuilder();

  if (config.role || config.title) {
    const identity = [config.role, config.title].filter(Boolean).join(" — ");
    builder.addSection("Identity", `You are ${identity}.`);
  }

  if (config.mission) {
    builder.addSection("Mission", config.mission);
  }

  builder.addSection(
    "Operating Rules",
    [
      "- Scope to assigned tasks. Do not freelance beyond your charter.",
      "- Progress comments must include: status line, what changed, what remains, next action.",
      "- For parallel or long work, create child issues instead of polling.",
      "- Mark work `blocked` with owner + action when waiting on others.",
      "- Handoff to reviewer or manager when done with implementation.",
      "- Start actionable work immediately; do not stop at a plan unless planning was requested.",
      "- Leave durable progress with a clear next action.",
      "- Prefer the smallest verification that proves the change.",
      "- Respect budget, pause/cancel, approval gates, and company boundaries.",
    ].join("\n"),
  );

  if (config.cwd) {
    builder.addSection(
      "Workspace",
      `Your working directory is: \`${config.cwd}\`\nAll relative paths resolve against this directory.`,
    );
  }

  if (config.sections) {
    for (const section of config.sections) {
      builder.addSection(section.title, section.content);
    }
  }

  if (registry) {
    builder.addToolsSection(registry);
  }

  return builder.build();
}
