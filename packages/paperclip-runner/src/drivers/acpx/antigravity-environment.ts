import { CONFIGURED_ENVIRONMENT_KEYS, configuredEnvironmentKeys } from "../../configured-environment.js";

/** The selected Gemini key owns authentication; task variables cannot reroute it. */
export function sanitizeAntigravityEnvironment(environment: NodeJS.ProcessEnv): void {
  const removed = new Set<string>();
  const names = configuredEnvironmentKeys(environment);
  for (const name of Object.keys(environment)) {
    if (name === "GEMINI_API_KEY") continue;
    if (/^(?:GOOGLE_|GEMINI_|AGY_|ANTIGRAVITY_|GCLOUD_|CLOUDSDK_|PYTHON)/i.test(name)) {
      delete environment[name]; removed.add(name);
    }
  }
  if (environment[CONFIGURED_ENVIRONMENT_KEYS] !== undefined) {
    environment[CONFIGURED_ENVIRONMENT_KEYS] = JSON.stringify(names.filter(name => !removed.has(name)));
  }
}
