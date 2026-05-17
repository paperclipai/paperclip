export function isDevelopmentEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "development";
}
