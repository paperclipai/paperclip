import type { Command } from "commander";
import {
  getStoredOperatorCredential,
  loginOperatorCli,
  removeStoredOperatorCredential,
  revokeStoredOperatorCredential,
} from "../../client/operator-auth.js";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface AuthLoginOptions extends BaseClientOptions {
  instanceAdmin?: boolean;
}

interface AuthLogoutOptions extends BaseClientOptions {}
interface AuthWhoamiOptions extends BaseClientOptions {}

export function registerClientAuthCommands(auth: Command): void {
  addCommonClientOptions(
    auth
      .command("login")
      .description("Authenticate the CLI for operator-user access")
      .option("--instance-admin", "Request instance-admin approval instead of plain operator access", false)
      .action(async (opts: AuthLoginOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const login = await loginOperatorCli({
            apiBase: ctx.api.apiBase,
            requestedAccess: opts.instanceAdmin ? "instance_admin_required" : "operator",
            requestedCompanyId: ctx.companyId ?? null,
            command: "paperclipai auth login",
          });
          printOutput(
            {
              ok: true,
              apiBase: ctx.api.apiBase,
              userId: login.userId ?? null,
              approvalUrl: login.approvalUrl,
            },
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );

  addCommonClientOptions(
    auth
      .command("logout")
      .description("Remove the stored operator-user credential for this API base")
      .action(async (opts: AuthLogoutOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const credential = getStoredOperatorCredential(ctx.api.apiBase);
          if (!credential) {
            printOutput({ ok: true, apiBase: ctx.api.apiBase, revoked: false, removedLocalCredential: false }, { json: ctx.json });
            return;
          }
          let revoked = false;
          try {
            await revokeStoredOperatorCredential({
              apiBase: ctx.api.apiBase,
              token: credential.token,
            });
            revoked = true;
          } catch {
            // Remove the local credential even if the server-side revoke fails.
          }
          const removedLocalCredential = removeStoredOperatorCredential(ctx.api.apiBase);
          printOutput(
            {
              ok: true,
              apiBase: ctx.api.apiBase,
              revoked,
              removedLocalCredential,
            },
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    auth
      .command("whoami")
      .description("Show the current operator-user identity for this API base")
      .action(async (opts: AuthWhoamiOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const me = await ctx.api.get<{
            user: { id: string; name: string; email: string } | null;
            userId: string;
            isInstanceAdmin: boolean;
            companyIds: string[];
            source: string;
            keyId: string | null;
          }>("/api/cli-auth/me");
          printOutput(me, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
