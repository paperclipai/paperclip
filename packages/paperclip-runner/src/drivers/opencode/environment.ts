import { CONFIGURED_ENVIRONMENT_KEYS, SECRET_ENVIRONMENT_KEYS, configuredEnvironment } from "../../configured-environment.js";

export function configuredOpenCodeEnvironment(source: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const environment = configuredEnvironment(source);
  for (const key of Object.keys(environment)) {
    if (/^(?:OPENCODE_|XDG_)/i.test(key)) delete environment[key];
    // The secret-name marker is runner input, not task environment.
    if (key === SECRET_ENVIRONMENT_KEYS) delete environment[key];
  }
  if (environment[CONFIGURED_ENVIRONMENT_KEYS] !== undefined) {
    environment[CONFIGURED_ENVIRONMENT_KEYS] = JSON.stringify(
      Object.keys(environment).filter(key => key !== CONFIGURED_ENVIRONMENT_KEYS).sort(),
    );
  }
  return environment;
}
