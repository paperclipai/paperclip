// Credential-free native probe bridge to the exact production policy source.
import { readFileSync } from "node:fs";
import { assertCopilotSessionUpdatePolicy, CopilotDetachedWorkUnsupportedError } from "../src/drivers/acpx/copilot-policy.ts";
try {
  assertCopilotSessionUpdatePolicy(JSON.parse(readFileSync(0, "utf8")));
} catch (error) {
  if (!(error instanceof CopilotDetachedWorkUnsupportedError)) throw error;
  process.stdout.write(error.code);
  process.exitCode = 42;
}
