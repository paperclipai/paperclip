import { Command } from "commander";
import { upsertSidebarOrderPreferenceSchema } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface IdsOptions extends BaseClientOptions {
  ids: string;
}

interface CompanyIdsOptions extends BaseClientOptions {
  companyId?: string;
  ids: string;
}

interface InboxListOptions extends BaseClientOptions {
  companyId?: string;
}

interface InboxDismissOptions extends BaseClientOptions {
  companyId?: string;
  itemKey: string;
}

function splitCsv(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function registerUserCommands(program: Command): void {
  const user = program
    .command("user")
    .description("Per-user state (sidebar prefs, inbox dismissals)");

  const sidebar = user.command("sidebar").description("Sidebar order preferences");

  const companyOrder = sidebar
    .command("company-order")
    .description("Cross-company sidebar ordering");

  addCommonClientOptions(
    companyOrder
      .command("get")
      .description("Get the user's cross-company sidebar order")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>("/api/sidebar-preferences/me");
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    companyOrder
      .command("set")
      .description("Replace the user's cross-company sidebar order")
      .requiredOption("--ids <list>", "Comma-separated company UUIDs in display order")
      .action(async (opts: IdsOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const parsed = upsertSidebarOrderPreferenceSchema.parse({
            orderedIds: splitCsv(opts.ids),
          });
          const row = await ctx.api.put<unknown>("/api/sidebar-preferences/me", parsed);
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  const projectOrder = sidebar
    .command("project-order")
    .description("Per-company project ordering");

  addCommonClientOptions(
    projectOrder
      .command("get")
      .description("Get the user's project order for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.get<unknown>(
            `/api/companies/${ctx.companyId}/sidebar-preferences/me`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    projectOrder
      .command("set")
      .description("Replace the user's project order in a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--ids <list>", "Comma-separated project UUIDs in display order")
      .action(async (opts: CompanyIdsOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const parsed = upsertSidebarOrderPreferenceSchema.parse({
            orderedIds: splitCsv(opts.ids),
          });
          const row = await ctx.api.put<unknown>(
            `/api/companies/${ctx.companyId}/sidebar-preferences/me`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  const inbox = user.command("inbox").description("Inbox dismissals");

  addCommonClientOptions(
    inbox
      .command("dismissals")
      .description("List dismissed inbox items for the current user in a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: InboxListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<unknown[]>(
            `/api/companies/${ctx.companyId}/inbox-dismissals`,
          )) ?? [];
          if (ctx.json) {
            printOutput(rows, { json: true });
            return;
          }
          if (rows.length === 0) {
            printOutput([], { json: false });
            return;
          }
          for (const r of rows as Array<Record<string, unknown>>) {
            console.log(
              formatInlineRecord({
                itemKey: r.itemKey as string | null,
                dismissedAt:
                  r.dismissedAt instanceof Date
                    ? r.dismissedAt.toISOString()
                    : (r.dismissedAt as string | null),
              }),
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    inbox
      .command("dismiss")
      .description("Dismiss an inbox item (key format: approval|join|run:<id>)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--item-key <key>", "Item key to dismiss")
      .action(async (opts: InboxDismissOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.post<unknown>(
            `/api/companies/${ctx.companyId}/inbox-dismissals`,
            { itemKey: opts.itemKey },
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    user
      .command("sidebar-badges")
      .description("Get sidebar badges (unread counts, indicators) for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.get<unknown>(
            `/api/companies/${ctx.companyId}/sidebar-badges`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    user
      .command("profile")
      .description("Get a user's company profile by slug")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .argument("<userSlug>", "User slug")
      .action(async (userSlug: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.get<unknown>(
            `/api/companies/${ctx.companyId}/users/${encodeURIComponent(userSlug)}/profile`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
