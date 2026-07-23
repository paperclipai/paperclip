import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCopilotAcpCommand,
  buildCopilotAcpConfig,
  execute,
  resolveCopilotHome,
} from "./execute.js";

describe("copilot_local ACP configuration", () => {
  const originalCopilotHome = process.env.COPILOT_HOME;

  afterEach(async () => {
    if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = originalCopilotHome;
  });

  it("builds a token-safe Copilot ACP stdio command", () => {
    const command = buildCopilotAcpCommand({
      command: "copilot",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      extraArgs: ["--no-ask-user"],
    });

    expect(command).toContain("'copilot' '--acp' '--stdio'");
    expect(command).toContain("'--model' 'gpt-5.6-sol'");
    expect(command).toContain("'--effort' 'high'");
    expect(command).toContain("'--no-auto-update'");
    expect(command).toContain("'--no-remote-export'");
    expect(command).toContain("'--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN'");
    expect(command).not.toContain("PAPERCLIP_API_KEY");
    expect(command).toContain("'--no-ask-user'");
  });

  it("honors an explicit ACP command override", () => {
    expect(buildCopilotAcpCommand({ agentCommand: "custom-copilot-acp" })).toBe(
      "custom-copilot-acp",
    );
  });

  it("gives managed safety flags final precedence over extra arguments", () => {
    const command = buildCopilotAcpCommand({
      extraArgs: [
        "--auto-update",
        "--remote",
        "--remote-export",
        "--color",
        "--log-level",
        "debug",
        "--secret-env-vars=OTHER_TOKEN",
      ],
    });

    expect(command.lastIndexOf("'--no-auto-update'")).toBeGreaterThan(
      command.lastIndexOf("'--auto-update'"),
    );
    expect(command.lastIndexOf("'--no-remote'")).toBeGreaterThan(
      command.lastIndexOf("'--remote'"),
    );
    expect(command.lastIndexOf("'--no-remote-export'")).toBeGreaterThan(
      command.lastIndexOf("'--remote-export'"),
    );
    expect(command.lastIndexOf("'--no-color'")).toBeGreaterThan(
      command.lastIndexOf("'--color'"),
    );
    expect(command.lastIndexOf("'error'")).toBeGreaterThan(command.lastIndexOf("'debug'"));
    expect(
      command.lastIndexOf(
        "'--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN'",
      ),
    ).toBeGreaterThan(command.lastIndexOf("'--secret-env-vars=OTHER_TOKEN'"));
  });

  it("uses the normal Copilot home without overriding explicit config", () => {
    process.env.COPILOT_HOME = path.resolve("/shared/copilot");

    expect(resolveCopilotHome({})).toBe(path.resolve("/shared/copilot"));

    const inherited = buildCopilotAcpConfig({});
    expect(inherited.env).toMatchObject({
      COPILOT_AUTO_UPDATE: "false",
      COPILOT_HOME: path.resolve("/shared/copilot"),
    });

    const explicit = buildCopilotAcpConfig({ env: { COPILOT_HOME: "/custom/copilot" } });
    expect(explicit.env).toMatchObject({ COPILOT_HOME: "/custom/copilot" });
  });

  it("rejects unsupported remote execution targets", async () => {
    await expect(
      execute({
        executionTarget: { kind: "remote" },
      } as never),
    ).rejects.toThrow("supported only on local execution targets");
  });
});
