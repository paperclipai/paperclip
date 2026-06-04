import { Command } from "commander";
import pc from "picocolors";
import {
  readContext,
  resolveContextPath,
  resolveProfile,
  setCurrentProfile,
  upsertProfile,
  type ClientContextProfile,
} from "../../client/context.js";
import { printOutput } from "./common.js";

interface ContextOptions {
  dataDir?: string;
  context?: string;
  profile?: string;
  json?: boolean;
}

interface ContextSetOptions extends ContextOptions {
  apiBase?: string;
  companyId?: string;
  persona?: "board" | "agent";
  agentId?: string;
  agentName?: string;
  apiKeyEnvVarName?: string;
  use?: boolean;
}

export function registerContextCommands(program: Command): void {
  const context = program.command("context").description("Manage CLI client context profiles");

  context
    .command("show")
    .description("Show current context and active profile")
    .option("-d, --data-dir <path>", "Paperclip data directory root (isolates state from ~/.paperclip)")
    .option("--context <path>", "Path to CLI context file")
    .option("--profile <name>", "Profile to inspect")
    .option("--json", "Output raw JSON")
    .action((opts: ContextOptions) => {
      const contextPath = resolveContextPath(opts.context);
      const store = readContext(opts.context);
      const resolved = resolveProfile(store, opts.profile);
      const payload = {
        contextPath,
        currentProfile: store.currentProfile,
        profileName: resolved.name,
        profile: resolved.profile,
        profiles: store.profiles,
      };
      printOutput(payload, { json: opts.json });
    });

  context
    .command("list")
    .description("List available context profiles")
    .option("-d, --data-dir <path>", "Paperclip data directory root (isolates state from ~/.paperclip)")
    .option("--context <path>", "Path to CLI context file")
    .option("--json", "Output raw JSON")
    .action((opts: ContextOptions) => {
      const store = readContext(opts.context);
      const rows = Object.entries(store.profiles).map(([name, profile]) => ({
        name,
        current: name === store.currentProfile,
        apiBase: profile.apiBase ?? null,
        companyId: profile.companyId ?? null,
        persona: profile.persona ?? null,
        agentId: profile.agentId ?? null,
        agentName: profile.agentName ?? null,
        apiKeyEnvVarName: profile.apiKeyEnvVarName ?? null,
      }));
      printOutput(rows, { json: opts.json });
    });

  context
    .command("use")
    .description("Set active context profile")
    .argument("<profile>", "Profile name")
    .option("-d, --data-dir <path>", "Paperclip data directory root (isolates state from ~/.paperclip)")
    .option("--context <path>", "Path to CLI context file")
    .action((profile: string, opts: ContextOptions) => {
      setCurrentProfile(profile, opts.context);
      console.log(pc.green(`Active profile set to '${profile}'.`));
    });

  context
    .command("set")
    .description("Set values on a profile")
    .option("-d, --data-dir <path>", "Paperclip data directory root (isolates state from ~/.paperclip)")
    .option("--context <path>", "Path to CLI context file")
    .option("--profile <name>", "Profile name (default: current profile)")
    .option("--api-base <url>", "Default API base URL")
    .option("--company-id <id>", "Default company ID")
    .option("--persona <persona>", "Profile persona: board or agent")
    .option("--agent-id <id>", "Default agent ID for agent persona")
    .option("--agent-name <name>", "Default agent display name")
    .option("--api-key-env-var-name <name>", "Env var containing API key (recommended)")
    .option("--use", "Set this profile as active")
    .option("--json", "Output raw JSON")
    .action((opts: ContextSetOptions) => {
      const existing = readContext(opts.context);
      const targetProfile = opts.profile?.trim() || existing.currentProfile || "default";

      upsertProfile(
        targetProfile,
        buildContextPatch(opts),
        opts.context,
      );

      if (opts.use) {
        setCurrentProfile(targetProfile, opts.context);
      }

      const updated = readContext(opts.context);
      const resolved = resolveProfile(updated, targetProfile);
      const payload = {
        contextPath: resolveContextPath(opts.context),
        currentProfile: updated.currentProfile,
        profileName: resolved.name,
        profile: resolved.profile,
      };

      if (!opts.json) {
        console.log(pc.green(`Updated profile '${targetProfile}'.`));
        if (opts.use) {
          console.log(pc.green(`Set '${targetProfile}' as active profile.`));
        }
      }
      printOutput(payload, { json: opts.json });
    });
}

function setIfProvided<K extends keyof ClientContextProfile>(
  patch: Partial<ClientContextProfile>,
  key: K,
  value: ClientContextProfile[K] | undefined,
): void {
  if (value !== undefined) {
    patch[key] = value;
  }
}

function buildContextPatch(opts: ContextSetOptions): Partial<ClientContextProfile> {
  const patch: Partial<ClientContextProfile> = {};
  setIfProvided(patch, "apiBase", opts.apiBase);
  setIfProvided(patch, "companyId", opts.companyId);
  setIfProvided(patch, "persona", parsePersona(opts.persona));
  setIfProvided(patch, "agentId", opts.agentId);
  setIfProvided(patch, "agentName", opts.agentName);
  setIfProvided(patch, "apiKeyEnvVarName", opts.apiKeyEnvVarName);
  return patch;
}

function parsePersona(value: string | undefined): "board" | "agent" | undefined {
  if (value === undefined) return undefined;
  if (value === "board" || value === "agent") return value;
  throw new Error("Invalid --persona value. Use board or agent.");
}
