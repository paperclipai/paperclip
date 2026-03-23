/**
 * Auto-registers with the relay server when PAPERCLIP_RELAY_URL is set
 * but no token exists yet. Persists the token to .env and adds the relay
 * hostname to config.json so subsequent restarts skip registration.
 */

import fs from "node:fs";
import { resolvePaperclipConfigPath, resolvePaperclipEnvPath } from "../paths.js";
import { logger } from "../middleware/logger.js";

interface RegisterResult {
  token: string;
  instanceId: string;
  relayHostname: string;
}

export async function autoRegisterRelay(relayUrl: string): Promise<RegisterResult | null> {
  const registerUrl = relayUrl
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://")
    .replace(/\/+$/, "") + "/register";

  logger.info({ registerUrl }, "Relay: no token found, auto-registering");

  let resp: Response;
  try {
    resp = await fetch(registerUrl, { method: "POST" });
  } catch (err) {
    logger.error({ err }, "Relay: failed to reach relay server for registration");
    return null;
  }

  if (!resp.ok) {
    logger.error({ status: resp.status }, "Relay: registration failed");
    return null;
  }

  const data = await resp.json() as { token: string; instanceId: string; publicUrl: string };

  if (!data.token || !data.instanceId || !data.publicUrl) {
    logger.error("Relay: registration response missing required fields");
    return null;
  }

  let relayHostname: string;
  try {
    relayHostname = new URL(data.publicUrl).hostname;
  } catch {
    logger.error({ publicUrl: data.publicUrl }, "Relay: invalid publicUrl in registration response");
    return null;
  }

  // Persist token to .env
  appendToEnvFile("PAPERCLIP_RELAY_TOKEN", data.token);

  // Add relay hostname to config.json allowedHostnames
  addAllowedHostname(relayHostname);

  logger.info(
    { instanceId: data.instanceId, relayHostname },
    "Relay: registered successfully",
  );

  return { token: data.token, instanceId: data.instanceId, relayHostname };
}

function appendToEnvFile(key: string, value: string): void {
  const envPath = resolvePaperclipEnvPath();
  try {
    let content = "";
    if (fs.existsSync(envPath)) {
      content = fs.readFileSync(envPath, "utf-8");
      if (!content.endsWith("\n")) content += "\n";
    }
    // Remove existing key if present (shouldn't be, but safe)
    const lines = content.split("\n").filter((l) => l !== "" && !l.startsWith(`${key}=`));
    lines.push(`${key}=${value}`);
    fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");
    logger.info({ path: envPath }, `Relay: saved ${key} to .env`);
  } catch (err) {
    logger.warn({ err, path: envPath }, `Relay: could not persist ${key} to .env`);
  }
}

function addAllowedHostname(hostname: string): void {
  const configPath = resolvePaperclipConfigPath();
  try {
    if (!fs.existsSync(configPath)) return;

    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const hostnames: string[] = raw?.server?.allowedHostnames ?? [];
    const normalized = hostname.trim().toLowerCase();

    if (hostnames.some((h: string) => h.trim().toLowerCase() === normalized)) {
      return; // already present
    }

    hostnames.push(normalized);
    if (!raw.server) {
      raw.server = {};
    }
    raw.server.allowedHostnames = hostnames;
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    logger.info({ hostname, path: configPath }, "Relay: added hostname to config.json allowedHostnames");
  } catch (err) {
    logger.warn({ err }, "Relay: could not update config.json allowedHostnames");
  }
}
