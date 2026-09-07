/** Server-owned rollout policy. Never read from agent tool arguments. */
export function runnerApiToolsEnabled(
  companyId: string,
  bindingOverride?: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const enabled = environment.PAPERCLIP_RUNNER_API_TOOLS_ENABLED;
  // An explicit operator stop wins over a previously advertised tool or eval binding.
  if (enabled === "false" || bindingOverride === false) return false;
  if (enabled !== "true" && bindingOverride !== true) return false;
  const companies = environment.PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS;
  if (companies === undefined) return true;
  return companies.split(",").map(value => value.trim()).filter(Boolean).includes(companyId);
}
