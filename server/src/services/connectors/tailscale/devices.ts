import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { unprocessable } from "../../../errors.js";

export type TailscaleDevice = { id: string; name: string; hostname: string; address: string; os: string; online: boolean };

export function parseTailscaleDevices(value: unknown): TailscaleDevice[] {
  if (!value || typeof value !== "object" || !("BackendState" in value) || value.BackendState !== "Running") {
    throw unprocessable("Reconnect Tailscale to view your machines.", { code: "tailscale_reauthorization_required" });
  }
  const peers = "Peer" in value && value.Peer && typeof value.Peer === "object" ? Object.values(value.Peer) : [];
  return peers.flatMap((peer): TailscaleDevice[] => {
    if (!peer || typeof peer !== "object" || typeof peer.ID !== "string" || !peer.ID) return [];
    const address = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs.find((ip: unknown) => typeof ip === "string" && isIP(ip)) : undefined;
    if (typeof address !== "string") return [];
    const hostname = typeof peer.DNSName === "string" ? peer.DNSName.replace(/\.$/, "") : address;
    return [{ id: peer.ID, name: typeof peer.HostName === "string" ? peer.HostName : hostname,
      hostname, address, os: typeof peer.OS === "string" ? peer.OS : "unknown", online: peer.Online === true }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export async function readTailscaleDevices(socket: string): Promise<TailscaleDevice[]> {
  const { stdout } = await promisify(execFile)(process.env.PAPERCLIP_TAILSCALE_CLI ?? "tailscale", [`--socket=${socket}`, "status", "--json"], {
    timeout: 5000, maxBuffer: 2 * 1024 * 1024,
  });
  return parseTailscaleDevices(JSON.parse(stdout));
}
