/**
 * A deliberately narrow no-agent response for an operator asking which model
 * an issue's assignee is configured to use. This is configuration metadata,
 * not a claim about an opaque provider-side snapshot.
 */
export function configuredRuntimeIdentityReply(input: {
  body: string;
  adapterType: string;
  agentAdapterConfig: unknown;
  issueAssigneeAdapterOverrides: unknown;
}): string | null {
  const question = input.body.trim().replace(/\s+/g, " ").toLowerCase();
  const asksForModel = [
    /^(?:what|which)(?: exact)? model(?: are you| you are| is (?:this|the agent)|(?: do| does) (?:this|the agent) use| exactly)?\??$/,
    /^(?:what|which) model (?:are you|is (?:this|the agent)|(?:do|does) (?:this|the agent) use)(?: exactly)?\??$/,
  ].some((pattern) => pattern.test(question));
  if (!asksForModel) return null;

  const issueOverrides = record(input.issueAssigneeAdapterOverrides);
  const overrideConfig = record(issueOverrides?.adapterConfig);
  const agentConfig = record(input.agentAdapterConfig);
  const overrideModel = stringValue(overrideConfig?.model);
  const agentModel = stringValue(agentConfig?.model);
  const model = overrideModel ?? agentModel;
  const source = overrideModel ? "this issue's model override" : "the agent's primary configuration";

  return [
    "**Configured runtime identity**",
    `- Adapter: \`${input.adapterType}\``,
    `- Model: ${model ? `\`${model}\`` : "adapter default (no explicit model ID configured)"}`,
    `- Source: ${source}`,
    "",
    "This is the Paperclip configuration, not an inferred provider-side snapshot. No agent run was started for this answer.",
  ].join("\n");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
