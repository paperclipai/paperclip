import { prepareTestDriveEnvironment, testDriveCommand } from "../../../cli/src/commands/test-drive.js";

const options = { harness: "codex", apiKeyEnv: "INSTRUCTION_FIXTURE_KEY", companyName: "Instruction Lifecycle QA", browser: false } as const;
process.env.INSTRUCTION_FIXTURE_KEY = "not-a-provider-key";
await prepareTestDriveEnvironment(options);
process.env.NODE_ENV = "test";
// Only this disposable server exposes the process adapter as an instruction-
// capable fixture. Production process-adapter capabilities are unchanged.
const { registerServerAdapter } = await import("../../../server/src/adapters/index.js");
const { processAdapter } = await import("../../../server/src/adapters/process/index.js");
registerServerAdapter({
  ...processAdapter,
  supportsInstructionsBundle: true,
  execute: async input => {
    const result = await processAdapter.execute({ ...input, config: { ...input.config,
      env: { ...(input.config.env as Record<string, unknown>), INSTRUCTION_FIXTURE_PATH: input.config.instructionsFilePath },
    } });
    // execute returns only after the real child process exits.
    await input.onProviderStopped?.();
    return result;
  },
});
await testDriveCommand(options);
