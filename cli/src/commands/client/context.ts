import { Command } from "commander";
import pc from "picocolors";
import {
  readContext,
  resolveContextPath,
  resolveProfile,
  setCurrentProfile,
  upsertProfile,
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
  apiKeyEnvVarName?: string;
  use?: boolean;
}

export function registerContextCommands(program: Command): void {
  const context = program.command("context").description("Manage CLI client context profiles");

  context
    .command("show")
    .description("Show current context and active profile")
    .option("-d, --data-dir <path>", "Ironworks data directory root (isolates state from ~/.ironworks)")
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
    .option("-d, --data-dir <path>", "Ironworks data directory root (isolates state from ~/.ironworks)")
    .option("--context <path>", "Path to CLI context file")
    .option("--json", "Output raw JSON")
    .action((opts: ContextOptions) => {
      const store = readContext(opts.context);
      const rows = Object.entries(store.profiles).map(([name, profile]) => ({
        name,
        current: name === store.currentProfile,
        apiBase: profile.apiBase ?? null,
        companyId: profile.companyId ?? null,
        apiKeyEnvVarName: profile.apiKeyEnvVarName ?? null,
      }));
      printOutput(rows, { json: opts.json });
    });

  context
    .command("use")
    .description("Set active context profile")
    .argument("<profile>", "Profile name")
    .option("-d, --data-dir <path>", "Ironworks data directory root (isolates state from ~/.ironworks)")
    .option("--context <path>", "Path to CLI context file")
    .action((profile: string, opts: ContextOptions) => {
      setCurrentProfile(profile, opts.context);
      console.log(pc.green(`Active profile set to '${profile}'.`));
    });

  context
    .command("set")
    .description("Set values on a profile")
    .option("-d, --data-dir <path>", "Ironworks data directory root (isolates state from ~/.ironworks)")
    .option("--context <path>", "Path to CLI context file")
    .option("--profile <name>", "Profile name (default: current profile)")
    .option("--api-base <url>", "Default API base URL")
    .option("--company-id <id>", "Default company ID")
    .option("--api-key-env-var-name <name>", "Env var containing API key (recommended)")
    .option("--use", "Set this profile as active")
    .option("--json", "Output raw JSON")
    .action((opts: ContextSetOptions) => {
      const existing = readContext(opts.context);
      const targetProfile = opts.profile?.trim() || existing.currentProfile || "default";

      upsertProfile(
        targetProfile,
        {
          apiBase: opts.apiBase,
          companyId: opts.companyId,
          apiKeyEnvVarName: opts.apiKeyEnvVarName,
        },
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
