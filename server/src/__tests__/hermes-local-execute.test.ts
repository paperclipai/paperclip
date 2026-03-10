import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-hermes-local/server";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

interface CapturePayload {
  argv: string[];
}

function buildContext(
  config: Record<string, unknown>,
  overrides?: Partial<AdapterExecutionContext>,
): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "Hermes Agent",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      taskId: "task-123",
      issueId: "issue-123",
      wakeReason: "issue_assigned",
      issueIds: ["issue-123"],
    },
    onLog: async () => {},
    ...overrides,
  };
}

async function writeFakeHermesCommand(commandPath: string) {
  const script = `#!/usr/bin/env node
import fs from "node:fs";
const capturePath = process.env.PAPERCLIP_TEST_CAPTURE_PATH;
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify({ argv: process.argv.slice(2) }));
}
process.stdout.write("Hermes Agent banner noise\\n");
process.stdout.write("╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮\\n");
process.stdout.write("done and commented on the issue\\n\\nwith one extra line\\n");
process.stdout.write("╰──────────────────────────────────────────────────────────────────────────────╯\\n");
process.stdout.write("Session:        20260310_999999_test\\n");
`;
  await fs.writeFile(commandPath, script, { encoding: "utf8", mode: 0o755 });
}

describe("hermes_local execute", () => {
  it("extracts assistant summary and session id from hermes CLI output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-local-exec-"));
    const cwd = path.join(root, "workspace");
    const commandPath = path.join(root, "hermes");
    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      await fs.mkdir(cwd, { recursive: true });
      await writeFakeHermesCommand(commandPath);

      const result = await execute(
        buildContext({
          command: commandPath,
          cwd,
        }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain("done and commented on the issue");
      expect(result.sessionParams).toEqual({
        sessionId: "20260310_999999_test",
        cwd,
      });
      expect(result.sessionDisplayId).toBe("20260310_999999_test");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prepends instructions file contents to the Hermes prompt and forwards extra args", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-local-prompt-"));
    const cwd = path.join(root, "workspace");
    const commandPath = path.join(root, "hermes");
    const capturePath = path.join(root, "capture.json");
    const instructionsFilePath = path.join(root, "hermes-ceo.md");
    const previousHome = process.env.HOME;
    process.env.HOME = root;

    let invocationPrompt = "";
    try {
      await fs.mkdir(cwd, { recursive: true });
      await fs.writeFile(instructionsFilePath, "Run the company like you mean it.\nNo generic status fluff.");
      await writeFakeHermesCommand(commandPath);

      const result = await execute(
        buildContext(
          {
            command: commandPath,
            cwd,
            instructionsFilePath,
            extraArgs: ["--debug", "--emit-json"],
            env: {
              PAPERCLIP_TEST_CAPTURE_PATH: capturePath,
            },
            promptTemplate: "Continue your assigned Paperclip work.",
          },
          {
            onMeta: async (meta) => {
              invocationPrompt = meta.prompt ?? "";
            },
          },
        ),
      );

      expect(result.exitCode).toBe(0);
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as CapturePayload;
      expect(capture.argv).toEqual(expect.arrayContaining(["chat", "--debug", "--emit-json", "-q"]));
      const promptIndex = capture.argv.indexOf("-q");
      expect(promptIndex).toBeGreaterThanOrEqual(0);
      const promptArg = capture.argv[promptIndex + 1] ?? "";
      expect(promptArg).toContain("Run the company like you mean it.");
      expect(promptArg).toContain("No generic status fluff.");
      expect(promptArg).toContain(`The above agent instructions were loaded from ${instructionsFilePath}.`);
      expect(promptArg).toContain("Continue your assigned Paperclip work.");
      expect(invocationPrompt).toContain("Run the company like you mean it.");
      expect(invocationPrompt).toContain("No generic status fluff.");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
