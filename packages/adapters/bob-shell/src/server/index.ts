export { execute } from "./execute.js";
export { syncBobWorkspace } from "./workspace.js";
export { testEnvironment } from "./test.js";
export { listBobShellSkills, syncBobShellSkills } from "./skills.js";
export { prepareBobPromptBundle } from "./prompt-cache.js";
export {
  classifyBobError,
  describeBobFailure,
  isSessionError,
  shouldRetry,
  detectBobAuthRequired,
  detectBobSessionError,
  detectBobMaxTurns,
  detectBobTimeout,
  type BobErrorClassification,
  type ErrorClassification,
} from "./error-detection.js";
