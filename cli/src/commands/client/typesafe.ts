import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { typesafeAskSchema } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  resolveCommandContext,
  printOutput,
  type BaseClientOptions,
} from "./common.js";

export function registerTypesafeCommands(program: Command) {
  const typesafe = program
    .command("typesafe")
    .description("Ask TypeSafe's Jev model typed questions about a state");
  addCommonClientOptions(
    typesafe
      .command("ask")
      .requiredOption(
        "--file <path>",
        "JSON request file: state, questions, optional model and connectionId",
      ),
    { includeCompany: true },
  ).action(async (opts: BaseClientOptions & { file: string }) => {
    const ctx = resolveCommandContext(opts, { requireCompany: true });
    const input = typesafeAskSchema.parse(
      JSON.parse(await readFile(opts.file, "utf8")),
    );
    printOutput(
      await ctx.api.post(`/api/companies/${ctx.companyId}/typesafe/ask`, input),
      { json: true },
    );
  });
}
