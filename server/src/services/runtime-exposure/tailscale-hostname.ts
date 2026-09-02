import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TAILSCALE_BIN = "/usr/bin/tailscale";

type TailscaleStatus = {
  Self?: { DNSName?: unknown };
};

/** Parse only this node's MagicDNS name from `tailscale status --json`. */
export function parseTailscaleDnsName(value: unknown): string {
  const dnsName = (value as TailscaleStatus | null)?.Self?.DNSName;
  if (typeof dnsName !== "string") {
    throw new Error("tailscale status did not include Self.DNSName");
  }
  const normalized = dnsName.trim().replace(/\.$/, "").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(normalized) || !normalized.includes(".")) {
    throw new Error("tailscale status returned an invalid Self.DNSName");
  }
  return normalized;
}

/**
 * Read-only hostname discovery. This does not require Tailscale operator
 * authority; all Serve mutations remain isolated in the host broker.
 */
export async function resolveTailscaleDnsName(input?: {
  tailscaleBinPath?: string;
  timeoutMs?: number;
}): Promise<string> {
  const configured = process.env.PAPERCLIP_TAILSCALE_DNS_NAME?.trim();
  if (configured) return parseTailscaleDnsName({ Self: { DNSName: configured } });

  const tailscaleBinPath = input?.tailscaleBinPath ?? DEFAULT_TAILSCALE_BIN;
  if (!tailscaleBinPath.startsWith("/")) {
    throw new Error("tailscale binary path must be absolute");
  }
  const { stdout } = await execFileAsync(tailscaleBinPath, ["status", "--json"], {
    encoding: "utf8",
    timeout: input?.timeoutMs ?? 3_000,
    maxBuffer: 1024 * 1024,
  });
  return parseTailscaleDnsName(JSON.parse(stdout));
}
