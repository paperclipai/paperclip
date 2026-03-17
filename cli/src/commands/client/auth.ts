import { Command } from "commander";
import pc from "picocolors";
import readline from "node:readline";
import {
  readContext,
  resolveProfile,
  upsertProfile,
} from "../../client/context.js";
import { PaperclipApiClient } from "../../client/http.js";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface AuthLoginOptions extends BaseClientOptions {
  email?: string;
  password?: string;
}

interface AuthCreateKeyOptions extends BaseClientOptions {
  name: string;
}

interface AuthRevokeKeyOptions extends BaseClientOptions {}

function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    // Hide input by disabling terminal echo
    if (process.stdin.isTTY) {
      process.stderr.write(prompt);
      const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
      stdin.setRawMode?.(true);
      let password = "";
      const onData = (ch: Buffer) => {
        const char = ch.toString("utf8");
        if (char === "\n" || char === "\r" || char === "\u0004") {
          stdin.setRawMode?.(false);
          process.stdin.removeListener("data", onData);
          rl.close();
          process.stderr.write("\n");
          resolve(password);
        } else if (char === "\u0003") {
          // Ctrl-C
          stdin.setRawMode?.(false);
          process.stdin.removeListener("data", onData);
          rl.close();
          process.stderr.write("\n");
          reject(new Error("Aborted"));
        } else if (char === "\u007F" || char === "\b") {
          // Backspace
          password = password.slice(0, -1);
        } else {
          password += char;
        }
      };
      process.stdin.on("data", onData);
    } else {
      // Non-TTY: just read a line
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

function promptInput(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function resolveApiBase(options: BaseClientOptions): string {
  const context = readContext(options.context);
  const { profile } = resolveProfile(context, options.profile);

  return (
    options.apiBase?.trim() ||
    process.env.PAPERCLIP_API_URL?.trim() ||
    profile.apiBase ||
    "http://localhost:3100"
  );
}

export function registerAuthClientCommands(auth: Command): void {
  // auth login
  addCommonClientOptions(
    auth
      .command("login")
      .description("Authenticate with email and password")
      .option("--email <email>", "Account email address (omit to be prompted)")
      .option("--password <password>", "Account password (omit to be prompted)")
      .action(async (opts: AuthLoginOptions) => {
        try {
          const email = opts.email || (await promptInput("Email: "));
          if (!email) {
            throw new Error("Email is required");
          }

          const password = opts.password || (await promptPassword("Password: "));
          if (!password) {
            throw new Error("Password is required");
          }

          const apiBase = resolveApiBase(opts);
          const client = new PaperclipApiClient({ apiBase });
          const response = await client.rawPost("/api/auth/sign-in/email", {
            email,
            password,
          });

          if (!response.ok) {
            const text = await response.text();
            let message = "Invalid credentials";
            try {
              const body = JSON.parse(text);
              if (body?.message) message = body.message;
              else if (body?.error) message = body.error;
            } catch {
              // use default message
            }
            if (response.status === 404 || (response.status === 401 && /not found|no user|does not exist/i.test(message))) {
              throw new Error("User not found \u2014 sign up via the Paperclip UI first, then use `auth login`.");
            }
            throw new Error(message);
          }

          // Extract session token from Set-Cookie header
          const setCookie = response.headers.getSetCookie?.() ?? [];
          let sessionToken: string | null = null;
          for (const cookie of setCookie) {
            const match = cookie.match(/better-auth\.session_token=([^;]+)/);
            if (match) {
              sessionToken = match[1];
              break;
            }
          }

          // Fallback: try raw set-cookie header
          if (!sessionToken) {
            const rawCookie = response.headers.get("set-cookie") ?? "";
            const match = rawCookie.match(/better-auth\.session_token=([^;]+)/);
            if (match) {
              sessionToken = match[1];
            }
          }

          if (!sessionToken) {
            throw new Error("Login succeeded but no session token was returned. The server may not support email/password authentication.");
          }

          // Get user info with the session
          const sessionClient = new PaperclipApiClient({ apiBase, sessionToken });
          const userInfo = await sessionClient.get<{ name?: string; email?: string }>("/api/users/me");

          // Store session token in context profile
          const context = readContext(opts.context);
          const { name: profileName } = resolveProfile(context, opts.profile);
          upsertProfile(profileName, { sessionToken, apiBase }, opts.context);

          const displayName = userInfo?.name || email;
          const displayEmail = userInfo?.email || email;
          console.log(pc.green(`Logged in as ${displayName} (${displayEmail})`));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // auth create-key
  addCommonClientOptions(
    auth
      .command("create-key")
      .description("Create a Personal Access Token (PAT)")
      .requiredOption("--name <name>", "Name for the API key")
      .action(async (opts: AuthCreateKeyOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post<{ id: string; name: string; key: string; keyPrefix: string; createdAt: string }>(
            "/api/users/me/api-keys",
            { name: opts.name },
          );

          if (!result) {
            throw new Error("Failed to create API key");
          }

          // Store the key in context profile
          upsertProfile(ctx.profileName, { apiKey: result.key }, opts.context);

          if (ctx.json) {
            printOutput(result, { json: true });
          } else {
            console.log(pc.green(`Created API key: ${result.key}`));
            console.log(pc.dim(`Key stored in profile '${ctx.profileName}'. This key will not be shown again.`));
            console.log(pc.yellow(`\u26A0  Context file contains secrets \u2014 keep chmod 600 and do not commit to git.`));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // auth whoami
  addCommonClientOptions(
    auth
      .command("whoami")
      .description("Show current authenticated identity")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const me = await ctx.api.get<{
            id: string;
            name: string;
            email: string;
            companies?: Array<{ id: string; name: string; role: string | null }>;
            authSource?: string;
          }>("/api/users/me");

          if (!me) {
            throw new Error("Not authenticated. Run `paperclipai auth login` first.");
          }

          if (ctx.json) {
            printOutput(me, { json: true });
            return;
          }

          console.log(`User: ${me.name} (${me.email})`);
          if (me.companies && me.companies.length > 0) {
            const companyList = me.companies
              .map((c) => `${c.name}${c.role ? ` (${c.role})` : ""}`)
              .join(", ");
            console.log(`Companies: ${companyList}`);
          }

          const authSource = me.authSource ?? "unknown";
          const keyPrefix = ctx.profile.apiKey?.slice(0, 14) ?? "";
          if (authSource === "user_api_key" && keyPrefix) {
            console.log(`Auth: ${authSource} (${keyPrefix}...)`);
          } else {
            console.log(`Auth: ${authSource}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // auth list-keys
  addCommonClientOptions(
    auth
      .command("list-keys")
      .description("List your Personal Access Tokens")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const keys = await ctx.api.get<Array<{
            id: string;
            name: string;
            keyPrefix: string;
            lastUsedAt: string | null;
            revokedAt: string | null;
            expiresAt: string | null;
            createdAt: string;
          }>>("/api/users/me/api-keys");

          if (!keys || keys.length === 0) {
            if (ctx.json) {
              printOutput([], { json: true });
            } else {
              console.log(pc.dim("No API keys found. Create one with `paperclipai auth create-key --name <name>`."));
            }
            return;
          }

          if (ctx.json) {
            printOutput(keys, { json: true });
            return;
          }

          // Print table
          const header = padColumns(["ID", "Name", "Prefix", "Created", "Last Used", "Status"]);
          console.log(pc.bold(header));
          console.log("-".repeat(header.length));

          for (const key of keys) {
            const status = key.revokedAt ? pc.red("revoked") : pc.green("active");
            const lastUsed = key.lastUsedAt ? formatDate(key.lastUsedAt) : pc.dim("never");
            console.log(padColumns([
              key.id.slice(0, 8),
              key.name,
              key.keyPrefix,
              formatDate(key.createdAt),
              lastUsed,
              status,
            ]));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // auth revoke-key
  addCommonClientOptions(
    auth
      .command("revoke-key")
      .description("Revoke a Personal Access Token")
      .argument("<keyId>", "API key ID to revoke")
      .action(async (keyId: string, opts: AuthRevokeKeyOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          await ctx.api.delete(`/api/users/me/api-keys/${keyId}`);

          if (ctx.json) {
            printOutput({ revoked: true, keyId }, { json: true });
          } else {
            console.log(pc.green(`API key ${keyId} revoked.`));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function padColumns(cols: string[]): string {
  const widths = [10, 16, 16, 12, 12, 10];
  return cols.map((col, i) => String(col).padEnd(widths[i] ?? 12)).join("  ");
}
