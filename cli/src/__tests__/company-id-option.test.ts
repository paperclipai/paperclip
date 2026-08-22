import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerCompanyCommands } from "../commands/client/company.js";
import { registerIssueCommands } from "../commands/client/issue.js";
import { registerAgentCommands } from "../commands/client/agent.js";
import { registerApprovalCommands } from "../commands/client/approval.js";
import { registerActivityCommands } from "../commands/client/activity.js";
import { registerDashboardCommands } from "../commands/client/dashboard.js";
import { registerFeedbackCommands } from "../commands/client/feedback.js";
import { registerGoalCommands } from "../commands/client/goal.js";
import { registerPluginCommands } from "../commands/client/plugin.js";
import { registerProjectCommands } from "../commands/client/project.js";
import { registerSecretCommands } from "../commands/client/secrets.js";
import { registerTokenCommands } from "../commands/client/token.js";

interface CommandNode {
  path: string;
  command: Command;
}

/**
 * Walk the full command tree (recursively, through all subcommands) and
 * return every node along with its dotted path (e.g. "agent list").
 */
function walkCommands(command: Command, path: string[] = []): CommandNode[] {
  const currentPath = [...path, command.name()].filter(Boolean).join(" ");
  const nodes: CommandNode[] = [{ path: currentPath || "<root>", command }];
  for (const sub of command.commands) {
    nodes.push(...walkCommands(sub, [...path, command.name()].filter(Boolean)));
  }
  return nodes;
}

describe("--company-id option registration", () => {
  it("never declares --company-id as a mandatory (required) option", () => {
    const program = new Command();

    registerCompanyCommands(program);
    registerIssueCommands(program);
    registerAgentCommands(program);
    registerApprovalCommands(program);
    registerActivityCommands(program);
    registerDashboardCommands(program);
    registerFeedbackCommands(program);
    registerGoalCommands(program);
    registerPluginCommands(program);
    registerProjectCommands(program);
    registerSecretCommands(program);
    registerTokenCommands(program);

    const nodes = walkCommands(program);

    // Trap: commander's `option.required` merely reflects that the flag takes
    // a value (`<id>`). The `.requiredOption` discriminator is
    // `option.mandatory`. Asserting on `required` would pass on the broken
    // (pre-fix) tree and is worthless.
    const offenders = nodes
      .filter((node) => node.command.options.some((option) => option.long === "--company-id" && option.mandatory === true))
      .map((node) => node.path);

    expect(offenders, `--company-id must never be mandatory; offending commands: ${offenders.join(", ")}`).toEqual([]);
  });

  it("never declares --company-id more than once on the same command", () => {
    const program = new Command();

    registerCompanyCommands(program);
    registerIssueCommands(program);
    registerAgentCommands(program);
    registerApprovalCommands(program);
    registerActivityCommands(program);
    registerDashboardCommands(program);
    registerFeedbackCommands(program);
    registerGoalCommands(program);
    registerPluginCommands(program);
    registerProjectCommands(program);
    registerSecretCommands(program);
    registerTokenCommands(program);

    const nodes = walkCommands(program);

    const duplicates = nodes
      .filter((node) => node.command.options.filter((option) => option.long === "--company-id").length > 1)
      .map((node) => node.path);

    expect(duplicates, `--company-id must not be declared more than once; offending commands: ${duplicates.join(", ")}`).toEqual([]);
  });
});
