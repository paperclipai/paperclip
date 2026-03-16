/**
 * Platform Adapter - Built-in LLM-based agent runtime
 *
 * This adapter runs agents natively in Paperclip using configured LLM providers.
 * No external processes, no working directories, just LLM + tools.
 */

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterSessionCodec,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { logger } from "../../middleware/logger.js";
import { executePlatformAgentTask } from "./executor.js";
import { platformSessionCodec } from "./session-codec.js";

export const platformAdapter = {
  type: "platform",
  execute: executePlatformAgent,
  testEnvironment: testPlatformEnvironment,
  sessionCodec: platformSessionCodec,
  models: [], // Uses configured LLM providers, not static models
  supportsLocalAgentJwt: false,
};

/**
 * Main execution handler for platform agents
 */
async function executePlatformAgent(
  context: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  try {
    logger.info(
      `[Platform] Agent execution starting for agent ${context.agent.id}`,
    );

    const result = await executePlatformAgentTask(context);

    logger.info(
      `[Platform] Agent execution completed with exit code ${result.exitCode}`,
    );

    return result;
  } catch (error) {
    logger.error(
      `[Platform] Unexpected execution error: ${error instanceof Error ? error.message : String(error)}`,
    );

    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: error instanceof Error ? error.message : "Unknown error",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

/**
 * Test environment for platform adapter (always available)
 */
async function testPlatformEnvironment(): Promise<AdapterEnvironmentTestResult> {
  return {
    adapterType: "platform",
    status: "pass",
    checks: [],
    testedAt: new Date().toISOString(),
  };
}

export type { PlatformAgentConfig } from "./types.js";
