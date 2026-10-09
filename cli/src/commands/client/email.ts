import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { emailSendSchema } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  resolveCommandContext,
  printOutput,
  type BaseClientOptions,
} from "./common.js";

export function registerEmailCommands(program: Command) {
  const email = program
    .command("email")
    .description(
      "Explicitly send and inspect task-bound AgentMail conversations",
    );
  addCommonClientOptions(email.command("inboxes"), {
    includeCompany: true,
  }).action(async (opts: BaseClientOptions) => {
    const ctx = resolveCommandContext(opts, { requireCompany: true });
    printOutput(
      await ctx.api.get(`/api/companies/${ctx.companyId}/email/inboxes`),
      { json: true },
    );
  });
  for (const verb of ["send", "reply"] as const) {
    addCommonClientOptions(
      email
        .command(verb)
        .requiredOption(
          "--file <path>",
          "JSON request file, including a stable idempotencyKey",
        ),
      { includeCompany: true },
    ).action(async (opts: BaseClientOptions & { file: string }) => {
      const ctx = resolveCommandContext(opts, { requireCompany: true });
      const input = emailSendSchema.parse(
        JSON.parse(await readFile(opts.file, "utf8")),
      );
      if ((verb === "reply") !== Boolean(input.conversationId))
        throw new Error(
          `${verb} requires ${verb === "reply" ? "an existing conversation" : "a parent task and a new conversation"}`,
        );
      printOutput(
        await ctx.api.post(`/api/companies/${ctx.companyId}/email/send`, input),
        { json: true },
      );
    });
  }
  addCommonClientOptions(
    email.command("thread").argument("<issueId>", "Email task ID"),
    { includeCompany: true },
  ).action(async (issueId: string, opts: BaseClientOptions) => {
    const ctx = resolveCommandContext(opts, { requireCompany: true });
    printOutput(
      await ctx.api.get(
        `/api/companies/${ctx.companyId}/email/tasks/${encodeURIComponent(issueId)}`,
      ),
      { json: true },
    );
  });
  addCommonClientOptions(
    email
      .command("delivery")
      .argument("<publicationId>", "Publication ID returned by send"),
    { includeCompany: true },
  ).action(async (publicationId: string, opts: BaseClientOptions) => {
    const ctx = resolveCommandContext(opts, { requireCompany: true });
    printOutput(
      await ctx.api.get(
        `/api/companies/${ctx.companyId}/email/deliveries/${encodeURIComponent(publicationId)}`,
      ),
      { json: true },
    );
  });
}
