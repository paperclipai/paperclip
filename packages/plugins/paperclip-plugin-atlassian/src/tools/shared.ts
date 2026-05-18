import type { PluginContext } from "@paperclipai/plugin-sdk";
import { JiraClient } from "../jira-client.js";

/**
 * Resolves a JiraClient from the plugin's instance config and secrets.
 * Called at tool-invocation time so the secret is never cached.
 */
export async function resolveJiraClient(ctx: PluginContext): Promise<JiraClient> {
  const config = await ctx.config.get();

  const baseUrl = config.jiraBaseUrl as string | undefined;
  const userEmail = config.jiraUserEmail as string | undefined;
  const apiTokenRef = config.jiraApiTokenRef as string | undefined;

  if (!baseUrl?.trim()) {
    throw new Error("Plugin config missing: jiraBaseUrl");
  }
  if (!userEmail?.trim()) {
    throw new Error("Plugin config missing: jiraUserEmail");
  }
  if (!apiTokenRef?.trim()) {
    throw new Error("Plugin config missing: jiraApiTokenRef");
  }

  const apiToken = await ctx.secrets.resolve(apiTokenRef.trim());

  return new JiraClient(
    { baseUrl: baseUrl.trim(), userEmail: userEmail.trim(), apiToken },
    (url, init) => ctx.http.fetch(String(url), init),
  );
}

/**
 * Resolves a Jira transition ID from either a raw numeric ID string or a
 * logical name defined in the transitionMapping config.
 */
export function resolveTransitionId(
  transitionInput: string,
  transitionMapping: Record<string, string>,
): string {
  if (/^\d+$/.test(transitionInput)) {
    return transitionInput;
  }
  const mapped = transitionMapping[transitionInput];
  if (!mapped) {
    const knownKeys = Object.keys(transitionMapping);
    const hint = knownKeys.length
      ? `Known mapping keys: ${knownKeys.join(", ")}`
      : "No transition mapping configured.";
    throw new Error(
      `Unknown transition name "${transitionInput}". ${hint} Provide a numeric transition ID or configure transitionMapping.`,
    );
  }
  return mapped;
}
