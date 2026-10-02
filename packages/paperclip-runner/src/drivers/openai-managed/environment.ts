import { createSanitizedClaudeManagedEnvironment } from "../claude-managed/environment.js";

/** Controller credential only. No env values are forwarded to the hosted sandbox. */
export function createSanitizedOpenAiManagedEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const source = environment ?? process.env;
  const result = createSanitizedClaudeManagedEnvironment(source);
  delete result.ANTHROPIC_API_KEY;
  if (typeof source.OPENAI_API_KEY === "string") result.OPENAI_API_KEY = source.OPENAI_API_KEY;
  return result;
}
