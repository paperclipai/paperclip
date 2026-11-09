import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const execute = promisify(execFile);
const privateActors = new WeakMap<ChatCatalogContext, { id: string; token: string; directory: string }>();
export async function prepareOwnedCli(ctx: ChatCatalogContext) {
  if (ctx.input.execution.environment.id !== "local") throw new Error("CLI companion journey requires the owned local attempt");
  const root = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
  if (!root) throw new Error("CLI companion requires an owned attempt directory");
  const directory = await mkdtemp(path.join(await realpath(root), "operator-cli-"));
  await mkdir(path.join(directory, "home"));
  const key = await ctx.input.api.postSensitive<{ id: string; token: string }>("/api/board-api-keys", {
    name: `catalog-operator-${ctx.input.nonce}`, requestedCompanyId: ctx.input.fixtures.company.id, expiresAt: new Date(Date.now() + 900_000).toISOString(),
  });
  if (!key.id || !key.token) throw new Error("Owned human CLI credential was not issued");
  ctx.input.privateSecrets?.push(key.token);
  privateActors.set(ctx, { ...key, directory });
  return { operatorDirectory: directory, operatorKeyId: key.id };
}
export async function runOwnedCli(ctx: ChatCatalogContext, args: string[]) {
  const actor = privateActors.get(ctx); if (!actor) throw new Error("Owned human CLI actor is unavailable");
  // A fresh minimal environment cannot pick up another operator's context,
  // stored auth, run ID, provider credentials or default company.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: path.join(actor.directory, "home"),
    PAPERCLIP_HOME: path.join(actor.directory, "home"), PAPERCLIP_CONTEXT: path.join(actor.directory, "context.json"), PAPERCLIP_API_KEY: actor.token,
    PAPERCLIP_API_URL: ctx.input.api.baseURL, PAPERCLIP_TELEMETRY_DISABLED: "1", NO_COLOR: "1" };
  const loader = fileURLToPath(new URL("../../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url));
  const entry = fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url));
  try {
    const result = await execute(process.execPath, ["--import", loader, entry, ...args], { cwd: actor.directory, env, timeout: 45_000, maxBuffer: 1_048_576 });
    if (result.stdout.includes(actor.token) || result.stderr.includes(actor.token)) throw new Error("Private CLI credential appeared in output");
    return result.stdout;
  } catch { throw new Error("Owned CLI command failed; private subprocess output withheld"); }
}
export async function cleanupOwnedCli(ctx: ChatCatalogContext) {
  const actor = privateActors.get(ctx); if (!actor) return;
  await ctx.input.api.delete(`/api/board-api-keys/${actor.id}`);
  privateActors.delete(ctx);
  const root = await realpath(process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT!);
  const owned = await realpath(actor.directory);
  if (!owned.startsWith(root + path.sep) || !path.basename(owned).startsWith("operator-cli-")) throw new Error("Refusing CLI cleanup outside its owned directory");
  await rm(owned, { recursive: true });
}

/** Parse one finite supported command into argv; never evaluate a shell. */
export function websiteCreateArgv(reply: string, fixture: { company: string; project: string; agent: string; apiBase: string }, bindings: Array<{ flag: string; placeholder: string; fixtureValue: string }> = []) {
  const blocks = [...reply.matchAll(/```(?:bash|sh|shell)?\s*\n([\s\S]*?)```/g)].map(match => match[1]!.replace(/\\\r?\n/g, " ").trim());
  const commands = blocks.flatMap(block => block.split(/\r?\n/)).filter(line => /^(?:paperclipai|npx(?: -y)? paperclipai|pnpm (?:exec )?paperclipai)\s+issue\s+create\b/.test(line.trim()));
  if (commands.length !== 1) throw new Error("One supported website creation command is required");
  const line = commands[0]!.trim();
  if (/[`;|&\n\r]|\$\(/.test(line)) throw new Error("Shell execution is not admitted in the owned CLI journey");
  const tokens = line.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g)!;
  const values = tokens.map(token => token.startsWith('"') ? JSON.parse(token) as string : token.startsWith("'") ? token.slice(1, -1) : token);
  const start = values.indexOf("issue"), argv = values.slice(start);
  const allowed = new Set(["--company-id", "-C", "--title", "--description", "--status", "--priority", "--assignee-agent-id", "--project-id", "--api-base"]);
  const fields = new Map<string, string>();
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!; if (flag === "--json" || flag === "--standalone") continue;
    if (!allowed.has(flag) || !argv[i + 1] || fields.has(flag)) throw new Error("Unsupported or ambiguous creation flags");
    let value = argv[++i]!;
    const target = ["--company-id", "-C"].includes(flag) ? fixture.company : flag === "--project-id" ? fixture.project : flag === "--assignee-agent-id" ? fixture.agent : undefined;
    // Only unresolved identifier placeholders are bound; actual wrong IDs fail.
    if (target && /^(?:<[A-Z_ -]+>|\$\{?[A-Z_]+\}?)$/.test(value)) { bindings.push({ flag, placeholder: value, fixtureValue: target }); value = target; argv[i] = target; }
    fields.set(flag, value);
  }
  if ((fields.get("--company-id") ?? fields.get("-C")) !== fixture.company || fields.get("--project-id") !== fixture.project
    || fields.get("--assignee-agent-id") !== fixture.agent || !fields.get("--title")
    || fields.has("--status") && !["backlog", "todo"].includes(fields.get("--status")!) || fields.has("--api-base") && fields.get("--api-base") !== fixture.apiBase)
    throw new Error("Creation command does not target exactly the intended company, project and Morgan");
  if (fields.has("--company-id") && fields.has("-C")) throw new Error("Duplicate company context flags are ambiguous");
  return argv;
}

/** The person's own Paperclip address is not knowable to the agent; a placeholder for it binds to the fixture origin. */
const addressPlaceholder = /^(?:<[^<>]+>|\$\{?[A-Z_]+\}?)$/;
const profileName = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export function contextGuidanceArgv(reply: string, fixture: { company: string; apiBase: string }) {
  const lines = [...reply.matchAll(/```(?:bash|sh|shell|zsh|console)?\s*\n([\s\S]*?)```/g)]
    .flatMap(match => match[1]!.replace(/\\\r?\n/g, " ").split(/\r?\n/))
    .map(line => line.trim().replace(/^\$\s+/, "")).filter(line => line && !line.startsWith("#"));
  let selected = false, readback = false;
  const commands: string[][] = [], bindings: Array<{ commandIndex: number; flag: string; placeholder: string; fixtureValue: string }> = [];
  const signIn: string[][] = [];
  for (const line of lines) {
    if (/[`;|&\n\r]|\$\(/.test(line)) return;
    const prefix = /^(?:paperclipai|npx(?: -y)? paperclipai(?:@latest)?|pnpm (?:exec )?paperclipai)\s+/;
    if (!prefix.test(line)) return;
    let tokens: string[];
    try { tokens = line.replace(prefix, "").match(/<[^<>]+>|"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g)!.map(token => token.startsWith('"') ? JSON.parse(token) as string : token.startsWith("'") ? token.slice(1, -1) : token); }
    catch { return; }
    const original = tokens;
    const family = original[0];
    const command = original[1], args = original.slice(2);
    // A sign-in step for a terminal that may not be signed in yet. The owned
    // human actor is already signed in and browser approval cannot run here,
    // so a well-formed login is recorded and not executed; other flags fail.
    if (family === "auth" && command === "login") {
      const flags = new Map<string, string>();
      while (args.length) {
        const flag = args.shift()!, value = args.shift();
        if (!["--api-base", "--company-id"].includes(flag) || !value || flags.has(flag)) return;
        flags.set(flag, value);
      }
      const base = flags.get("--api-base"), company = flags.get("--company-id");
      if (base !== undefined && base !== fixture.apiBase && !addressPlaceholder.test(base) || company !== undefined && company !== fixture.company) return;
      signIn.push(original); continue;
    }
    if (family === "company" || family === "auth") {
      // Reads only: listing companies, the selected company and the signed-in identity.
      if (family === "company" && command !== "current" && command !== "list" || family === "auth" && command !== "whoami"
        || args.length > 1 || args.length === 1 && args[0] !== "--json") return;
      if (family === "company" && command === "current" && selected) readback = true;
      commands.push(original); continue;
    }
    if (family !== "context") return;
    if (command === "use") { const name = args.shift(); if (!name || !profileName.test(name)) return; selected = true; }
    else if (command !== "show" && command !== "set" && command !== "list") return;
    let profile: string | undefined, company: string | undefined, apiBase: string | undefined, persona: string | undefined, use = false;
    const allowedFlags = command === "set" ? ["--profile", "--company-id", "--api-base", "--persona", "--use", "--json"]
      : command === "show" ? ["--profile", "--json"] : command === "list" ? ["--json"] : [];
    const flags = new Set<string>();
    while (args.length) {
      const flag = args.shift();
      if (!flag || !allowedFlags.includes(flag) || flags.has(flag)) return;
      flags.add(flag);
      if (flag === "--json") continue;
      if (flag === "--use") { use = true; continue; }
      if (!args.length) return;
      const value = args.shift()!;
      if (flag === "--profile") profile = value;
      if (flag === "--company-id") company = value;
      if (flag === "--api-base") apiBase = value;
      if (flag === "--persona") persona = value;
    }
    if (profile !== undefined && !profileName.test(profile)) return;
    if (command === "set") {
      // A set without --profile rewrites the person's current (other) profile.
      // The company is known in the conversation, so it must be the real id;
      // only the person's own Paperclip address may stay a placeholder.
      if (profile === undefined || company !== undefined && company !== fixture.company
        || apiBase !== undefined && apiBase !== fixture.apiBase && !addressPlaceholder.test(apiBase)
        || persona !== undefined && persona !== "board") return;
      if (apiBase !== undefined && apiBase !== fixture.apiBase) {
        const index = original.indexOf(apiBase);
        bindings.push({ commandIndex: commands.length, flag: "--api-base", placeholder: apiBase, fixtureValue: fixture.apiBase });
        original[index] = fixture.apiBase;
      }
      selected ||= use;
    }
    if (command === "show") readback ||= selected;
    commands.push(original);
  }
  return selected && readback ? { commands, bindings, signIn } : undefined;
}
export function validContextGuidance(reply: string, fixture: { company: string; apiBase: string }) {
  return !!contextGuidanceArgv(reply, fixture);
}
