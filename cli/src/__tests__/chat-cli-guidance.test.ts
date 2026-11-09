import { readFileSync } from "node:fs";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerClientAuthCommands } from "../commands/client/auth.js";
import { registerCompanyCommands } from "../commands/client/company.js";
import { registerContextCommands } from "../commands/client/context.js";
import { registerIssueCommands } from "../commands/client/issue.js";
import { registerRunCommands } from "../commands/client/run.js";

// Chat agents copy these commands into their answers verbatim, so every
// command and flag the chat guidance names must exist in this CLI.
const guidance = readFileSync(new URL("../../../server/src/services/agent-conversations.ts", import.meta.url), "utf8");

function cliProgram() {
  const program = new Command();
  registerContextCommands(program);
  registerIssueCommands(program);
  registerCompanyCommands(program);
  registerRunCommands(program.command("run"));
  registerClientAuthCommands(program.command("auth"));
  return program;
}

/** Resolves the command at the start of a guidance sentence; returns its path and the unknown part, if any. */
function resolve(program: Command, text: string): { path: string; error?: string } {
  const tokens = (text.match(/<[^<>]+>|\S+/g) ?? []).map(token => token.replace(/[.,;:]$/, ""));
  const path: string[] = [];
  const result = (error?: string) => ({ path: path.join(" "), error });
  let command = program, index = 0;
  while (index < tokens.length) {
    const next = command.commands.find(child => child.name() === tokens[index]);
    if (!next) break;
    command = next; path.push(next.name()); index += 1;
  }
  if (command === program) return result(`unknown command: ${tokens[0]}`);
  if (command.commands.length > 0) return result(`unknown subcommand ${tokens[index]} of ${command.name()}`);
  let argumentsLeft = command.registeredArguments.length;
  const given = new Set<string>();
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.startsWith("--")) {
      const option = command.options.find(row => row.long === token);
      if (!option) return result(`unknown flag ${token} for ${command.name()}`);
      given.add(token);
      if (option.required || option.optional) {
        const value = tokens[index + 1];
        if (option.required && (!value || value.startsWith("-"))) return result(`missing value for ${token}`);
        index += value && !value.startsWith("-") ? 2 : 1;
      } else index += 1;
    } else if (token.startsWith("<") && argumentsLeft > 0) {
      argumentsLeft -= 1; index += 1;
    } else break;
  }
  if (argumentsLeft > 0) return result(`missing arguments for ${command.name()}`);
  const missing = command.options.find(option => option.mandatory && !given.has(option.long!));
  return result(missing ? `missing required ${missing.long} for ${command.name()}` : undefined);
}

describe("chat CLI guidance", () => {
  const program = cliProgram();
  const commands = guidance.split("npx paperclipai ").slice(1).map(rest => resolve(program, rest.slice(0, 400)));

  it("names the commands a person runs for tasks, documents, runs and context", () => {
    const paths = commands.map(row => row.path);
    for (const command of ["issue create", "issue document:get", "run get", "run cancel", "context set", "context show", "company current", "auth whoami"])
      expect(paths).toContain(command);
  });

  it("names only commands, arguments and flags this CLI supports", () => {
    for (const command of commands) expect(command.error, command.path).toBeUndefined();
  });

  it("detects an invented command or flag", () => {
    expect(resolve(program, "run cancel <runId> --force now").error).toMatch(/unknown flag --force/);
    expect(resolve(program, "context select <name>").error).toMatch(/unknown subcommand select/);
    expect(resolve(program, "issue document:get <task> and more").error).toMatch(/missing arguments/);
    expect(resolve(program, "context set --profile --use").error).toMatch(/missing value for --profile/);
    expect(resolve(program, "issue create --project-id <projectId> creates").error).toMatch(/missing required --company-id/);
  });
});
