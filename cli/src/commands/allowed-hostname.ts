import * as p from "@clack/prompts";
import pc from "picocolors";
import { normalizeHostnameInput } from "../config/hostnames.js";
import { readConfig, resolveConfigPath, writeConfig } from "../config/store.js";

export async function addAllowedHostname(host: string, opts: { config?: string }): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  const config = readConfig(opts.config);

  if (!config) {
    p.log.error(`No config found at ${configPath}. Run ${pc.cyan("paperclip onboard")} first.`);
    return;
  }

  const normalized = normalizeHostnameInput(host);
  const current = new Set((config.server.allowedHostnames ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
  const existed = current.has(normalized);
  current.add(normalized);

  config.server.allowedHostnames = Array.from(current).sort();
  config.$meta.updatedAt = new Date().toISOString();
  config.$meta.source = "configure";
  writeConfig(config, opts.config);

  if (existed) {
    p.log.info(`Hostname ${pc.cyan(normalized)} is already allowed.`);
  } else {
    p.log.success(`Added allowed hostname: ${pc.cyan(normalized)}`);
    p.log.message(
      pc.dim("Restart the Paperclip server for this change to take effect."),
    );
  }

  if (!(config.server.deploymentMode === "authenticated" && config.server.exposure === "private")) {
    p.log.message(
      pc.dim("Note: allowed hostnames are enforced only in authenticated/private mode."),
    );
  }
}

