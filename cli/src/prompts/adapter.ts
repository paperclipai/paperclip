import * as p from "@clack/prompts";

// Available adapter types for agent creation/import
const AVAILABLE_ADAPTERS = [
  { value: "claude_local", label: "Claude (Anthropic)" },
  { value: "codex_local", label: "Codex (OpenAI)" },
  { value: "cursor", label: "Cursor" },
  { value: "gemini_local", label: "Gemini (Google)" },
  { value: "hermes_local", label: "Hermes Agent" },
  { value: "opencode_local", label: "OpenCode" },
  { value: "pi_local", label: "Pi (Inflection)" },
] as const;

export async function promptAdapterSelection(
  message = "Select an adapter type for process agents",
  defaultValue: string = "claude_local"
): Promise<string | symbol> {
  const adapter = await p.select({
    message,
    options: [...AVAILABLE_ADAPTERS],
    initialValue: defaultValue,
  });

  if (p.isCancel(adapter)) {
    p.cancel("Selection cancelled.");
    process.exit(0);
  }

  return adapter;
}

export async function promptImportAdapterSelection(
  processAgentSlugs: string[]
): Promise<Record<string, { adapterType: string }> | undefined> {
  if (processAgentSlugs.length === 0) {
    return undefined;
  }

  const agentPlural = processAgentSlugs.length === 1 ? "agent" : "agents";
  p.note(
    `The following ${processAgentSlugs.length} ${agentPlural} use the "process" adapter type and need a local adapter:\n` +
    processAgentSlugs.map(slug => `  • ${slug}`).join("\n"),
    "Process agents detected"
  );

  const shouldPrompt = await p.confirm({
    message: `Choose adapters individually for each agent? (No = use claude_local for all)`,
    initialValue: false,
  });

  if (p.isCancel(shouldPrompt)) {
    p.cancel("Selection cancelled.");
    process.exit(0);
  }

  if (!shouldPrompt) {
    // Use claude_local for all process agents
    return Object.fromEntries(
      processAgentSlugs.map(slug => [slug, { adapterType: "claude_local" }])
    );
  }

  // Interactive selection for each agent
  const overrides: Record<string, { adapterType: string }> = {};

  for (const agentSlug of processAgentSlugs) {
    const adapter = await p.select({
      message: `Select adapter for agent "${agentSlug}"`,
      options: [...AVAILABLE_ADAPTERS],
      initialValue: "claude_local",
    });

    if (p.isCancel(adapter)) {
      p.cancel("Selection cancelled.");
      process.exit(0);
    }

    overrides[agentSlug] = { adapterType: adapter as string };
  }

  return overrides;
}