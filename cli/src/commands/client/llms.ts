import { Command } from "commander";
import {
  addCommonClientOptions,
  handleCommandError,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

export function registerLlmsCommands(program: Command): void {
  const llms = program
    .command("llms")
    .description("LLM-facing reflection text endpoints (/llms/*)");

  addCommonClientOptions(
    llms
      .command("agent-configuration")
      .description("Index page describing agent configuration endpoints")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const text = await ctx.api.getText("/llms/agent-configuration.txt");
          process.stdout.write(text);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    llms
      .command("agent-icons")
      .description("List of valid agent icon names with examples")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const text = await ctx.api.getText("/llms/agent-icons.txt");
          process.stdout.write(text);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    llms
      .command("agent-config-doc")
      .description("Adapter-specific agent configuration documentation")
      .argument("<adapterType>", "Adapter type")
      .action(async (adapterType: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const text = await ctx.api.getText(
            `/llms/agent-configuration/${encodeURIComponent(adapterType)}.txt`,
          );
          process.stdout.write(text);
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
