import { logger } from "../../middleware/logger.js";
import type { JudgeInvoker } from "./types.js";

export class JudgeInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeInvocationError";
  }
}

/**
 * Default judge invoker placeholder. Production wiring should route through the
 * Agent Manager agent's configured model profile once LAB-42 enables supervision.
 */
export function createDefaultJudgeInvoker(): JudgeInvoker {
  return async () => {
    logger.warn("agent manager judge invocation is not configured");
    throw new JudgeInvocationError("Agent Manager judge is not configured");
  };
}
