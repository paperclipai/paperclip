/** Server-owned rollout policy. Never read from agent tool arguments. */
export function runnerApiToolsEnabled(
  companyId: string,
  bindingOverride?: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const enabled = environment.PAPERCLIP_RUNNER_API_TOOLS_ENABLED;
  // Enabled by default. Explicit settings fail closed; bindings can only narrow access.
  if ((enabled !== undefined && enabled !== "true") || bindingOverride === false) return false;
  const companies = environment.PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS;
  if (companies === undefined) return true;
  return companies.split(",").map(value => value.trim()).filter(Boolean).includes(companyId);
}
