import path from "node:path";
import { prepareTestDriveEnvironment, testDriveCommand } from "../../../cli/src/commands/test-drive.js";

const options = {
  harness: "codex",
  apiKeyEnv: "BOOTSTRAP_FIXTURE_KEY",
  companyName: "Workspace Recovery QA",
  browser: false,
} as const;

process.env.BOOTSTRAP_FIXTURE_KEY = "not-a-provider-key";
await prepareTestDriveEnvironment(options);
process.env.NODE_ENV = "test";
// Test-drive clears PAPERCLIP_* settings. Apply the fixture's short deadline
// after isolation; production snapshots may legitimately take much longer.
process.env.PAPERCLIP_WORKSPACE_GIT_SNAPSHOT_TIMEOUT_MS = "10000";
process.env.PATH = `${path.join(import.meta.dirname, "bin")}${path.delimiter}${process.env.PATH ?? ""}`;
await testDriveCommand(options);
